// Test de bout en bout du relais PHP (sans navigateur).
// Local  : php -S 127.0.0.1:8080 -t php-full   (PHP >= 7.4)
//          $env:TEST_PASSWORD='***'; node php-full/test/smoke.mjs
// Déployé : $env:BASE='https://assistance.example.org'; $env:TEST_PASSWORD='***'; node php-full/test/smoke.mjs
//
// Couvre aussi le chiffrement de bout en bout : l'arbre de clés reproduit ici
// (ECDH P-256 + HKDF-SHA256 + AES-256-GCM) est celui des navigateurs, pour
// vérifier que le serveur ne voit jamais une image en clair.

import assert from 'node:assert/strict';
import { createECDH, createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const PASSWORD = process.env.TEST_PASSWORD || '';
const IS_REMOTE = !!process.env.BASE;
// Repertoire des sessions, pour les controles qui exigent d'inspecter ce que le
// serveur a reellement efface (uniquement en local : rien a voir par HTTP).
const SESSIONS_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'data', 'sessions');
if (!PASSWORD) {
  console.error('Définissez TEST_PASSWORD (mot de passe technicien configuré).');
  process.exitCode = 2;
  process.exit();
}

const API = `${BASE}/api.php`;
const INFO = Buffer.from('easyhelper/v1/frame', 'utf8');

// Reproduit la dérivation de clé de crypto.js
function deriveKey(shared, saltHex) {
  const salt = Buffer.from(saltHex || '', 'hex');
  return Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32));
}

function encryptFrame(key, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

function decryptFrame(key, frame) {
  const iv = frame.subarray(0, 12);
  const ct = frame.subarray(12, frame.length - 16);
  const tag = frame.subarray(frame.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

async function main() {
  // Fixture locale : on repart d'un état vierge. Les compteurs anti-rebond et
  // les sessions laissées par une exécution précédente sont un état SERVEUR
  // persistant qui ferait échouer ce test pour une raison étrangère au code
  // testé (quota de créations, ou plafond de sessions par IP). Contre la
  // production, rien n'est touché : les limites restent celles du serveur.
  if (!IS_REMOTE) {
    try {
      const dataDir = path.join(SESSIONS_DIR, '..');
      for (const f of fs.readdirSync(dataDir)) {
        if (f.startsWith('rl_')) fs.rmSync(path.join(dataDir, f), { force: true });
      }
      for (const f of fs.readdirSync(SESSIONS_DIR)) {
        if (/^(meta_|frame_|presence_|tmpmeta_|tmpframe_)/.test(f)) {
          fs.rmSync(path.join(SESSIONS_DIR, f), { force: true });
        }
      }
    } catch { /* dossier absent : rien à purger */ }
  }

  // Le serveur limite les créations de session (6/min/IP : protection réelle
  // contre l'abus). Deux suites enchaînées dans la même minute, ou une
  // réexécution rapprochée, épuisent ce quota — et le test échouerait alors pour
  // une raison étrangère à ce qu'il mesure (constaté en production après un test
  // e2e). On attend donc que le quota se recharge, sans jamais assouplir la
  // limite du serveur : c'est elle qu'on veut exercer, pas contourner.
  async function createSession(body) {
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${API}?action=create`, {
        method: 'POST',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (res.status !== 429) return res;
      console.log('   (quota de créations atteint, attente 10 s avant nouvel essai…)');
      await new Promise((r) => setTimeout(r, 10000));
    }
    throw new Error('créations refusées (429) de façon persistante');
  }

  // 0. Diagnostic d'installation
  let r = await fetch(`${API}?action=selftest`);
  assert.equal(r.status, 200, 'selftest');
  const st = await r.json();
  assert.equal(st.password_configured, true, 'mot de passe configuré');
  assert.equal(st.data_writable, true, 'dossier data inscriptible');
  assert.equal(st.e2ee, true, 'chiffrement de bout en bout annoncé');

  // 1. Création de session (avec la clé publique de la personne aidée)
  const user = createECDH('prime256v1');
  user.generateKeys();
  const userPub = user.getPublicKey().toString('base64');

  r = await createSession({ userPub, diag: { os: 'TestOS', mem: 8, https: true } });
  assert.equal(r.status, 200, 'create');
  const sess = await r.json();
  assert.match(sess.code, /^\d{6}$/, 'code à 6 chiffres');
  assert.ok(/^[0-9a-f]{64}$/.test(sess.token), 'jeton utilisateur 256 bits');
  assert.ok(/^[0-9a-f]{32}$/.test(sess.salt), 'sel de dérivation fourni');
  assert.equal(sess.crypto, 'ecdh-p256-aesgcm', 'mode chiffré annoncé');

  // 2. Connexion technicien
  r = await fetch(`${API}?action=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'mauvais-mot-de-passe' }),
  });
  assert.equal(r.status, 401, 'mauvais mot de passe refusé');
  r = await fetch(`${API}?action=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(r.status, 200, 'login');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.ok(cookie.startsWith('SPINESID='), 'cookie de session présent');

  // 3. Vérification du code : le technicien publie sa clé publique éphémère
  const tech = createECDH('prime256v1');
  tech.generateKeys();
  const techPub = tech.getPublicKey().toString('base64');

  r = await fetch(`${API}?action=join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: sess.code, techPub }),
  });
  assert.equal(r.status, 200, 'join');
  const joined = await r.json();
  assert.equal(joined.userPub, userPub, 'clé publique utilisateur restituée');
  assert.equal(joined.salt, sess.salt, 'sel restitué');
  assert.equal(joined.diag && joined.diag.os, 'TestOS', 'diagnostics du poste restitués au technicien');

  r = await fetch(`${API}?action=join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: '000000' }),
  });
  assert.equal(r.status, 404, 'code inconnu refusé');
  r = await fetch(`${API}?action=join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: sess.code }),
  });
  assert.equal(r.status, 401, 'join sans authentification refusé');

  // 4. Upload sans jeton valide refusé
  r = await fetch(`${API}?action=upload`, {
    method: 'POST',
    headers: { 'X-Code': sess.code, 'X-Token': 'f'.repeat(64) },
    body: 'xx',
  });
  assert.equal(r.status, 401, 'upload sans jeton valide refusé');

  // 5. La personne aidée voit la clé du technicien (avant d'envoyer quoi que ce soit)
  r = await fetch(`${API}?action=status`, { headers: { 'X-Code': sess.code, 'X-Token': sess.token } });
  assert.equal(r.status, 200, 'status');
  const stat = await r.json();
  assert.equal(stat.state, 'live', 'session active');
  assert.equal(stat.tech_pub, techPub, 'clé publique du technicien transmise');
  // La présence n'est établie qu'au premier fetch du technicien (c'est le
  // long-polling qui prouve qu'il regarde), pas à la simple vérification du code.
  assert.equal(stat.tech_present, false, 'aucune présence tant que le technicien n\u2019a pas lu');

  // 6. Aller-retour chiffré complet : la personne aidée chiffre, le technicien déchiffre
  const userKey = deriveKey(user.computeSecret(Buffer.from(techPub, 'base64')), sess.salt);
  const techKey = deriveKey(tech.computeSecret(Buffer.from(userPub, 'base64')), sess.salt);
  assert.ok(userKey.equals(techKey), 'les deux postes dérivent la même clé');

  const secret = Buffer.from('CONTENU-CONFIDENTIEL-A-NE-PAS-EXPOSER '.repeat(100), 'utf8');
  const frame = encryptFrame(userKey, secret);
  const upHeaders = { 'X-Code': sess.code, 'X-Token': sess.token, 'Content-Type': 'application/octet-stream' };
  r = await fetch(`${API}?action=upload`, { method: 'POST', headers: upHeaders, body: frame });
  assert.equal(r.status, 200, 'upload chiffré');
  const up = await r.json();
  assert.equal(up.frameId, 1, 'frameId 1');
  assert.equal(up.tech_pub, techPub, 'clé du technicien renvoyée à la personne aidée');

  r = await fetch(`${API}?action=fetch&code=${sess.code}&after=0`, { headers: { cookie } });
  assert.equal(r.status, 200, 'fetch');
  assert.ok((r.headers.get('content-type') || '').includes('application/octet-stream'), 'contenu opaque');
  assert.equal(r.headers.get('x-encrypted'), '1', 'image annoncée chiffrée');
  assert.equal(r.headers.get('x-frame-id'), '1', 'x-frame-id 1');
  const got = Buffer.from(await r.arrayBuffer());
  assert.equal(got.length, frame.length, 'taille du cadre préservée');

  // Le serveur n'a relayé que des octets : le contenu en clair ne doit y apparaître nulle part.
  assert.ok(!got.includes(Buffer.from('CONTENU-CONFIDENTIEL')), 'aucun fragment en clair dans le cadre');
  assert.ok(!frame.includes(Buffer.from('CONTENU-CONFIDENTIEL')), 'aucun fragment en clair dans le chiffré');
  const fingerprint = createHash('sha256').update(got).digest('hex');
  assert.notEqual(fingerprint, createHash('sha256').update(secret).digest('hex'), 'cadre ≠ image en clair');

  assert.equal(decryptFrame(techKey, got).toString('utf8'), secret.toString('utf8'), 'image restituée à l\u2019identique');

  // 6b. Après lecture par le technicien, la personne aidée voit sa présence.
  r = await fetch(`${API}?action=status`, { headers: { 'X-Code': sess.code, 'X-Token': sess.token } });
  assert.equal(r.status, 200, 'status après lecture');
  const stat2 = await r.json();
  assert.equal(stat2.tech_present, true, 'présence du technicien détectée après lecture');

  // 7. Cadence limitée côté serveur (2e upload immédiat)
  r = await fetch(`${API}?action=upload`, { method: 'POST', headers: upHeaders, body: frame });
  assert.ok(r.status === 200 || r.status === 429, '2e upload immédiat accepté ou limité');
  if (r.status === 200) {
    const up2 = await r.json();
    assert.equal(up2.frameId, 2, 'frameId 2');
  }

  // 8. Arrêt par l'utilisateur -> session terminée
  r = await fetch(`${API}?action=stop`, { method: 'POST', headers: { 'X-Code': sess.code, 'X-Token': sess.token } });
  assert.equal(r.status, 200, 'stop');
  r = await fetch(`${API}?action=join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: sess.code }),
  });
  assert.equal(r.status, 404, 'session supprimée après arrêt');
  r = await fetch(`${API}?action=fetch&code=${sess.code}&after=0`, { headers: { cookie } });
  assert.equal(r.status, 200, 'fetch après arrêt');
  const fj = await r.json();
  assert.equal(fj.state, 'ended', 'état ended transmis au technicien');

  // 9. Image trop grande refusée
  const s2 = await (await createSession()).json();
  r = await fetch(`${API}?action=upload`, {
    method: 'POST',
    headers: { 'X-Code': s2.code, 'X-Token': s2.token },
    body: Buffer.alloc(300000, 1),
  });
  assert.equal(r.status, 413, 'image trop grande refusée');

  // 10. Arrêt par corps JSON, sans en-têtes personnalisés : c'est exactement ce
  // que le navigateur envoie à la fermeture de la fenêtre (sendBeacon).
  const s3 = await (await createSession()).json();
  r = await fetch(`${API}?action=stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: s3.code, token: s3.token }),
  });
  assert.equal(r.status, 200, 'arrêt par corps JSON (fermeture de fenêtre)');
  r = await fetch(`${API}?action=status`, { headers: { 'X-Code': s3.code, 'X-Token': s3.token } });
  assert.equal((await r.json()).state, 'ended', 'session close après l\'arrêt par corps JSON');

  // 11. Arrêt net décidé par le technicien : la personne aidée peut avoir
  // laissé son partage tourner, le technicien doit pouvoir clore de son côté.
  const s4 = await (await createSession({ userPub })).json();
  r = await fetch(`${API}?action=join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: s4.code }),
  });
  assert.equal(r.status, 200, 'join de la session à clore');
  r = await fetch(`${API}?action=end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: s4.code }),
  });
  assert.equal(r.status, 401, 'arrêt net refusé sans authentification technicien');
  r = await fetch(`${API}?action=end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: s4.code }),
  });
  assert.equal(r.status, 200, 'arrêt net accepté pour le technicien authentifié');
  // La personne aidée doit l'apprendre et ne plus pouvoir envoyer d'image.
  r = await fetch(`${API}?action=status`, { headers: { 'X-Code': s4.code, 'X-Token': s4.token } });
  const st4 = await r.json();
  assert.equal(st4.state, 'ended', 'la personne aidée voit la session close');
  assert.equal(st4.reason, 'tech-stopped', 'motif « arrêt par le technicien »');
  r = await fetch(`${API}?action=upload`, {
    method: 'POST',
    headers: { 'X-Code': s4.code, 'X-Token': s4.token },
    body: Buffer.alloc(64, 1),
  });
  assert.equal((await r.json()).state, 'ended', 'aucune image acceptée après l\'arrêt net');
  r = await fetch(`${API}?action=join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: s4.code }),
  });
  assert.equal(r.status, 404, 'code refusé après l\'arrêt net : on peut passer à la suivante');

  // 12. Disparition de la personne aidée : fenêtre fermée sans arrêt explicite.
  //     L'image doit disparaître sans attendre les 10 min d'inactivité.
  //     Ce contrôle exige d'antidater le repère de vie de la session : il ne
  //     peut se faire qu'en local, en écrivant directement la métadonnée.
  if (!IS_REMOTE) {
    const s5 = await (await createSession({ userPub })).json();
    r = await fetch(`${API}?action=upload`, {
      method: 'POST',
      headers: { 'X-Code': s5.code, 'X-Token': s5.token, 'Content-Type': 'application/octet-stream' },
      body: encryptFrame(deriveKey(tech.computeSecret(Buffer.from(userPub, 'base64')), s5.salt), Buffer.from('image-a-effacer')),
    });
    assert.equal(r.status, 200, 'image déposée avant la disparition');
    const metaFile = path.join(SESSIONS_DIR, `meta_${s5.code}.json`);
    const frameFile = path.join(SESSIONS_DIR, `frame_${s5.code}.bin`);
    assert.equal(fs.existsSync(frameFile), true, 'image bien stockée avant le contrôle');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.clientSeen = Date.now() - 600000;   // fenêtre fermée il y a 10 min
    meta.lastFrameAt = Date.now() - 600000;
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    r = await fetch(`${API}?action=status`, { headers: { 'X-Code': s5.code, 'X-Token': s5.token } });
    const st5 = await r.json();
    assert.equal(st5.state, 'ended', 'session close : la personne aidée n\'est plus là');
    assert.equal(st5.reason, 'client-gone', 'motif « client disparu »');
    assert.equal(fs.existsSync(frameFile), false, 'image effacée immédiatement, sans attendre 10 min');
  } else {
    console.log('   (contrôle de disparition du client : local uniquement)');
  }

  // 13. Journal des connexions : trace d'audit des accès technicien.
  //     Il doit exister, être refusé sans authentification, et ne JAMAIS
  //     contenir une adresse IP complète.
  const s6 = await (await createSession()).json();
  r = await fetch(`${API}?action=log`);
  assert.equal(r.status, 401, 'journal refusé sans authentification');
  r = await fetch(`${API}?action=join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: s6.code }),
  });
  assert.equal(r.status, 200, 'connexion du technicien (à journaliser)');
  r = await fetch(`${API}?action=log`, { headers: { cookie } });
  assert.equal(r.status, 200, 'journal accessible au technicien authentifié');
  const journal = await r.json();
  assert.ok(Array.isArray(journal.entries) && journal.entries.length > 0, 'au moins une entrée journalisée');
  const derniere = journal.entries[0];
  assert.equal(derniere.code, s6.code, 'session consignée dans la dernière entrée');
  assert.ok(typeof derniere.t === 'number' && derniere.t > 0, 'horodatage présent');
  assert.match(derniere.tech, /^[\d.]+x$|:x:x:x:x$|^inconnue$/, 'adresse du technicien offusquée');
  assert.match(derniere.user, /^[\d.]+x$|:x:x:x:x$|^inconnue$/, 'adresse de la personne aidée offusquée');
  // Aucune entrée ne doit contenir une adresse IPv4 complète (4 octets chiffrés).
  for (const e of journal.entries) {
    assert.doesNotMatch(String(e.tech), /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'aucune adresse complète (technicien)');
    assert.doesNotMatch(String(e.user), /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'aucune adresse complète (personne aidée)');
  }
  if (!IS_REMOTE) {
    // Contrôle de fond : ce qui est réellement écrit sur le disque.
    const raw = fs.readFileSync(path.join(SESSIONS_DIR, '..', 'access.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /"tech":"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}"/, 'le FICHIER ne contient aucune adresse complète');
  }

  // 14. Hygiène : on referme les sessions laissées ouvertes par ce test.
  //     Sans cela elles saturent la limite de sessions par IP et font échouer le
  //     test suivant (le nettoyage périodique ne passe qu'au bout d'une minute).
  //     Un test ne doit pas laisser d'état derrière lui.
  const restantes = [s2, s3, s4, s6];
  let fermees = 0;
  for (const s of restantes) {
    const res = await fetch(`${API}?action=stop`, {
      method: 'POST',
      headers: { 'X-Code': s.code, 'X-Token': s.token },
    }).catch(() => null);
    if (res && res.ok) fermees++;
  }
  console.log(`   hygiène : ${fermees} session(s) de test refermée(s)`);

  console.log('OK — relais PHP, authentification, limites, cycle de vie et chiffrement de bout en bout validés.');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => {
    console.error('ÉCHEC :', e.message);
    process.exitCode = 1;
  });
