// Test de bout en bout du relais Node.js (sans navigateur).
// Prérequis : serveur lancé sur 127.0.0.1:3080 et mot de passe technicien défini.
//   $env:TEST_PASSWORD='<mot-de-passe>'; node vps-node/test/ws-smoke.js
//
// Couvre aussi le chiffrement de bout en bout : l'arbre de clés reproduit ici
// (ECDH P-256 + HKDF-SHA256 + AES-256-GCM) est celui des navigateurs, pour
// vérifier que le relais ne voit jamais une image en clair.

import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
import {
  createECDH, createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHash,
} from 'node:crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:3080';
const PASSWORD = process.env.TEST_PASSWORD;

if (!PASSWORD) {
  console.error('Définissez TEST_PASSWORD (mot de passe technicien configuré).');
  process.exit(2);
}

const INFO = Buffer.from('easyhelper/v1/frame', 'utf8');
const FLAG_ENCRYPTED = 1;
const FLAG_PLAIN = 0;

// Reproduit la dérivation de clé de public/crypto.js (variante Node.js ;
// identique dans les deux variantes)
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

const openSockets = new Set();

// Les messages sont enregistrés dès la création de la socket : le serveur en
// envoie certains immédiatement à l'ouverture (joined, tech-joined), donc un
// écouteur posé après coup les manquerait.
function wsOpen(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    openSockets.add(ws);
    ws.__msgs = [];
    ws.on('message', (data, isBinary) => { ws.__msgs.push({ data, isBinary }); });
    ws.once('close', () => openSockets.delete(ws));
    const to = setTimeout(() => { ws.terminate(); reject(new Error('timeout : ' + url)); }, 5000);
    ws.once('open', () => { clearTimeout(to); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(to); reject(e); });
  });
}

// Consomme le premier message correspondant, déjà reçu ou à venir.
function waitMessage(ws, pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const i = ws.__msgs.findIndex((m) => pred(m.data, m.isBinary));
      if (i >= 0) { const [m] = ws.__msgs.splice(i, 1); resolve(m.data); return true; }
      if (Date.now() >= deadline) { reject(new Error('timeout message')); return true; }
      return false;
    };
    if (check()) return;
    const iv = setInterval(() => { if (check()) clearInterval(iv); }, 25);
  });
}

function waitClose(ws) {
  return new Promise((resolve) => ws.once('close', () => resolve()));
}

async function expectRejectedWS(url, options) {
  let rejected = false;
  try { await wsOpen(url, options); } catch { rejected = true; }
  assert.ok(rejected, 'connexion refusée attendue : ' + url);
}

// Lit un message texte JSON en ignorant les trames binaires
function waitJson(ws, type, timeoutMs = 5000) {
  return waitMessage(ws, (d, b) => {
    if (b) return false;
    try { return JSON.parse(d.toString()).type === type; } catch { return false; }
  }, timeoutMs).then((d) => JSON.parse(d.toString()));
}

async function main() {
  const step = (n, s) => console.log(`  étape ${n} : ${s}`);

  // 1. Création de session
  step(1, 'création de session');
  const sres = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ diag: { os: 'TestOS', mem: 8, https: true } }),
  });
  assert.equal(sres.status, 200, 'POST /api/session');
  const sess = await sres.json();  assert.match(sess.code, /^\d{6}$/, 'code à 6 chiffres');
  assert.ok(/^[0-9a-f]{64}$/.test(sess.token), 'jeton utilisateur 256 bits');
  assert.ok(/^[0-9a-f]{32}$/.test(sess.salt), 'sel de dérivation fourni');
  assert.equal(sess.crypto, 'ecdh-p256-aesgcm', 'mode chiffré annoncé');

  // 2. Connexion technicien
  const lres = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(lres.status, 200, 'POST /api/login');
  const cookie = lres.headers.get('set-cookie').split(';')[0];
  assert.ok(cookie.startsWith('sid='), 'cookie de session présent');

  const lbad = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'mot-de-passe-faux' }),
  });
  assert.equal(lbad.status, 401, 'mauvais mot de passe refusé');

  // 3. Vérification du code : le technicien publie sa clé publique éphémère
  const tech = createECDH('prime256v1');
  tech.generateKeys();
  const techPub = tech.getPublicKey().toString('base64');

  const jres = await fetch(`${BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: sess.code, techPub }),
  });
  assert.equal(jres.status, 200, 'POST /api/join');
  const joinedInfo = await jres.json();
  assert.equal(joinedInfo.salt, sess.salt, 'sel restitué au technicien');
  assert.equal(joinedInfo.diag && joinedInfo.diag.os, 'TestOS', 'diagnostics du poste restitués au technicien');

  const jbad = await fetch(`${BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: '000000' }),
  });
  assert.equal(jbad.status, 404, 'code inconnu refusé');

  const jnoauth = await fetch(`${BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: sess.code }),
  });
  assert.equal(jnoauth.status, 401, 'join sans authentification refusé');

  // 4. WebSockets : la personne aidée se connecte EN PREMIER (cas le plus
  //    courant : elle attend, puis le technicien arrive).
  step(4, 'connexion des deux canaux WebSocket');
  const user = createECDH('prime256v1');
  user.generateKeys();
  const userPub = user.getPublicKey().toString('base64');

  const userWs = await wsOpen(`ws://127.0.0.1:3080/ws/user`);
  userWs.send(JSON.stringify({ type: 'auth', token: sess.token, userPub }));
  await new Promise((r) => setTimeout(r, 150)); // laisse le serveur traiter l'auth

  // L'écouteur de la personne aidée est enregistré AVANT la connexion du
  // technicien : « tech-joined » part dès l'arrivée de celui-ci, et un écouteur
  // posé après coup manquerait le message.
  const techJoinedPromise = waitJson(userWs, 'tech-joined');

  const techWs = await wsOpen(`ws://127.0.0.1:3080/ws/tech?code=${sess.code}`, { headers: { cookie } });
  const joined = await waitJson(techWs, 'joined');
  assert.equal(joined.salt, sess.salt, 'sel transmis au technicien');
  assert.equal(joined.userPub, userPub, 'clé publique de la personne aidée transmise');
  assert.equal(joined.crypto, 'ecdh-p256-aesgcm', 'technicien informé du chiffrement');

  const techJoined = await techJoinedPromise;
  step(5, 'clés échangées');
  assert.equal(techJoined.techPub, techPub, 'clé publique du technicien transmise');
  assert.equal(techJoined.techCrypto, true, 'technicien capable de chiffrer');

  // 5. Les deux postes dérivent la même clé, sans jamais la transmettre
  const userKey = deriveKey(user.computeSecret(Buffer.from(techPub, 'base64')), sess.salt);
  const techKey = deriveKey(tech.computeSecret(Buffer.from(userPub, 'base64')), sess.salt);
  assert.ok(userKey.equals(techKey), 'les deux postes dérivent la même clé');

  // 6. Image chiffrée relayée telle quelle, puis déchiffrée côté technicien
  const secret = Buffer.from('CONTENU-CONFIDENTIEL-A-NE-PAS-EXPOSER '.repeat(400), 'utf8');
  const encrypted = encryptFrame(userKey, secret);
  const frame = Buffer.concat([Buffer.from([FLAG_ENCRYPTED]), encrypted]);

  const relayedPromise = waitMessage(techWs, (d, b) => b);
  userWs.send(frame);
  const relayed = await relayedPromise;
  assert.ok(Buffer.isBuffer(relayed), 'image relayée (binaire)');
  assert.equal(relayed.length, frame.length, 'taille du cadre préservée');
  assert.equal(relayed[0], FLAG_ENCRYPTED, 'marqueur « chiffré » préservé');

  // Le relais n'a manipulé que des octets : rien de lisible n'y figure.
  assert.ok(!relayed.includes(Buffer.from('CONTENU-CONFIDENTIEL')), 'aucun fragment en clair dans le cadre');
  assert.ok(!frame.includes(Buffer.from('CONTENU-CONFIDENTIEL')), 'aucun fragment en clair dans le chiffré');
  assert.notEqual(
    createHash('sha256').update(relayed).digest('hex'),
    createHash('sha256').update(secret).digest('hex'),
    'cadre ≠ image en clair',
  );

  const payload = Buffer.from(relayed).subarray(1);
  step(6, 'image déchiffrée');
  assert.equal(decryptFrame(techKey, payload).toString('utf8'), secret.toString('utf8'),
    'image restituée à l\u2019identique côté technicien');

  // 7. Une altération est détectée (AES-GCM authentifié)
  const tampered = Buffer.from(payload);
  tampered[20] ^= 0x01;
  assert.throws(() => decryptFrame(techKey, tampered), 'une altération du cadre est détectée');

  // 8. Repli en clair : une trame marquée « non chiffrée » passe aussi.
  //    Le relais ignore toute trame arrivée moins de 200 ms après la précédente
  //    (anti-flood) : on respecte donc ce délai avant d'envoyer.
  step(8, 'repli en clair');
  await new Promise((r) => setTimeout(r, 300));
  const plain = Buffer.from('image-claire-de-test');
  const plainFrame = Buffer.concat([Buffer.from([FLAG_PLAIN]), plain]);
  const plainPromise = waitMessage(techWs, (d, b) => b);
  userWs.send(plainFrame);
  const relayedPlain = await plainPromise;
  assert.equal(relayedPlain[0], FLAG_PLAIN, 'marqueur « clair » préservé');

  // 9. Arrêt par l'utilisateur -> fermeture des deux côtés
  step(9, 'arrêt utilisateur');
  const userClosed = waitClose(userWs);
  const techClosed = waitClose(techWs);
  userWs.send(JSON.stringify({ type: 'stop' }));
  await Promise.all([userClosed, techClosed]);

  // 10. La session a disparu
  const jgone = await fetch(`${BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: sess.code }),
  });
  assert.equal(jgone.status, 404, 'session supprimée après arrêt');

  // 11. Protections : accès technicien sans cookie / avec faux cookie
  step(11, 'protections du canal technicien');
  const s2 = await (await fetch(`${BASE}/api/session`, { method: 'POST' })).json();
  await expectRejectedWS(`ws://127.0.0.1:3080/ws/tech?code=${s2.code}`);
  await expectRejectedWS(`ws://127.0.0.1:3080/ws/tech?code=${s2.code}`, { headers: { cookie: 'sid=faux' } });

  // 12. Protection : jeton utilisateur invalide -> fermeture
  step(12, 'jeton utilisateur invalide');
  const userBad = await wsOpen(`ws://127.0.0.1:3080/ws/user`);
  const badClosed = waitClose(userBad);
  userBad.send(JSON.stringify({ type: 'auth', token: '0'.repeat(64) }));
  await badClosed;

  // 13. Arret net decide par le technicien (API) : la personne aidée peut avoir
  //     laissé son partage tourner (fenêtre oubliée). Le serveur doit clore et
  //     prévenir la personne aidée.
  step(13, 'arret net par le technicien (API)');
  const s3 = await (await fetch(`${BASE}/api/session`, { method: 'POST' })).json();
  const user3 = await wsOpen('ws://127.0.0.1:3080/ws/user');
  user3.send(JSON.stringify({ type: 'auth', token: s3.token }));
  await new Promise((r) => setTimeout(r, 150));
  const tech3 = await wsOpen(`ws://127.0.0.1:3080/ws/tech?code=${s3.code}`, { headers: { cookie } });
  await waitJson(tech3, 'joined');
  const ended3Promise = waitJson(user3, 'session-ended');
  const tech3Closed = waitClose(tech3);
  const endRes = await fetch(`${BASE}/api/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: s3.code }),
  });
  assert.equal(endRes.status, 200, 'POST /api/end');
  const ended3 = await ended3Promise;
  assert.equal(ended3.reason, 'tech-stopped', 'la personne aidée est prévenue de l\u2019arret');
  await tech3Closed;
  const jgone3 = await fetch(`${BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: s3.code }),
  });
  assert.equal(jgone3.status, 404, 'code refusé après l\u2019arret net : on passe à la suivante');
  const endNoAuth = await fetch(`${BASE}/api/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: s3.code }),
  });
  assert.equal(endNoAuth.status, 401, 'arret net refusé sans authentification');

  // 14. Arret net par le canal WebSocket du technicien (meme effet).
  step(14, 'arret net par le canal technicien');
  const s4 = await (await fetch(`${BASE}/api/session`, { method: 'POST' })).json();
  const user4 = await wsOpen('ws://127.0.0.1:3080/ws/user');
  user4.send(JSON.stringify({ type: 'auth', token: s4.token }));
  await new Promise((r) => setTimeout(r, 150));
  const tech4 = await wsOpen(`ws://127.0.0.1:3080/ws/tech?code=${s4.code}`, { headers: { cookie } });
  await waitJson(tech4, 'joined');
  const ended4Promise = waitJson(user4, 'session-ended');
  tech4.send(JSON.stringify({ type: 'stop' }));
  const ended4 = await ended4Promise;
  assert.equal(ended4.reason, 'tech-stopped', 'arret par le canal technicien');

  console.log('OK — relais Node.js, authentification, limites, cycle de vie et chiffrement de bout en bout validés.');
}

function finish(code) {
  for (const ws of [...openSockets]) {
    try { ws.terminate(); } catch { /* ignore */ }
  }
  // Pas de process.exit() : les sockets keep-alive de fetch/undici feraient
  // planter Node sous Windows. On laisse la boucle d'événements se vider.
  process.exitCode = code;
}

main()
  .then(() => finish(0))
  .catch((e) => {
    console.error('ÉCHEC :', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
    finish(1);
  });
