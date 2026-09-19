// Test de bout en bout du relais PHP (sans navigateur).
// Local  : php -S 127.0.0.1:8080 -t hostinger-php   (PHP >= 7.4)
//          $env:TEST_PASSWORD='***'; node hostinger-php/test/smoke.mjs
// Déployé : $env:BASE='https://assistance.example.org'; $env:TEST_PASSWORD='***'; node hostinger-php/test/smoke.mjs
//
// Couvre aussi le chiffrement de bout en bout : l'arbre de clés reproduit ici
// (ECDH P-256 + HKDF-SHA256 + AES-256-GCM) est celui des navigateurs, pour
// vérifier que le serveur ne voit jamais une image en clair.

import assert from 'node:assert/strict';
import { createECDH, createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHash } from 'node:crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const PASSWORD = process.env.TEST_PASSWORD || '';
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

  r = await fetch(`${API}?action=create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userPub }),
  });
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
  const s2 = await (await fetch(`${API}?action=create`, { method: 'POST' })).json();
  r = await fetch(`${API}?action=upload`, {
    method: 'POST',
    headers: { 'X-Code': s2.code, 'X-Token': s2.token },
    body: Buffer.alloc(300000, 1),
  });
  assert.equal(r.status, 413, 'image trop grande refusée');

  console.log('OK — relais PHP, authentification, limites, cycle de vie et chiffrement de bout en bout validés.');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => {
    console.error('ÉCHEC :', e.message);
    process.exitCode = 1;
  });
