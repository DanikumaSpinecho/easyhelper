// Test de bout en bout du relais (sans navigateur).
// Prérequis : serveur lancé sur 127.0.0.1:3080 et mot de passe technicien défini.
//   $env:TEST_PASSWORD='<mot-de-passe>'; node test/ws-smoke.js

import { WebSocket } from 'ws';
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://127.0.0.1:3080';
const PASSWORD = process.env.TEST_PASSWORD;

if (!PASSWORD) {
  console.error('Définissez TEST_PASSWORD (mot de passe technicien configuré).');
  process.exit(2);
}

const openSockets = new Set();

function wsOpen(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    openSockets.add(ws);
    ws.once('close', () => openSockets.delete(ws));
    const to = setTimeout(() => { ws.terminate(); reject(new Error('timeout : ' + url)); }, 5000);
    ws.once('open', () => { clearTimeout(to); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(to); reject(e); });
  });
}

function waitMessage(ws, pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const on = (data, isBinary) => {
      if (pred(data, isBinary)) { clearTimeout(to); ws.off('message', on); resolve(data); }
    };
    const to = setTimeout(() => { ws.off('message', on); reject(new Error('timeout message')); }, timeoutMs);
    ws.on('message', on);
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

async function main() {
  // 1. Création de session
  const sres = await fetch(`${BASE}/api/session`, { method: 'POST' });
  assert.equal(sres.status, 200, 'POST /api/session');
  const sess = await sres.json();
  assert.match(sess.code, /^\d{6}$/, 'code à 6 chiffres');
  assert.ok(/^[0-9a-f]{64}$/.test(sess.token), 'jeton utilisateur 256 bits');

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

  // 3. Vérification du code de session
  const jres = await fetch(`${BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: sess.code }),
  });
  assert.equal(jres.status, 200, 'POST /api/join');

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

  // 4. WebSockets
  const userWs = await wsOpen(`ws://127.0.0.1:3080/ws/user`);
  const techWs = await wsOpen(`ws://127.0.0.1:3080/ws/tech?code=${sess.code}`, { headers: { cookie } });
  const joined = await waitMessage(techWs, (d, b) => !b && d.toString().includes('joined'));
  assert.ok(joined, 'technicien notifié de la connexion');

  // 5. Authentification du canal utilisateur puis relais d'une image
  userWs.send(JSON.stringify({ type: 'auth', token: sess.token }));
  await new Promise((r) => setTimeout(r, 100)); // laisse le serveur traiter l'auth
  const frame = Buffer.alloc(50000, 7);
  const relayedPromise = waitMessage(techWs, (d, b) => b);
  userWs.send(frame);
  const relayed = await relayedPromise;
  assert.ok(Buffer.isBuffer(relayed), 'image relayée (binaire)');
  assert.equal(relayed.length, frame.length, 'taille de l\'image préservée');

  // 6. Arrêt par l'utilisateur -> fermeture des deux côtés
  const userClosed = waitClose(userWs);
  const techClosed = waitClose(techWs);
  userWs.send(JSON.stringify({ type: 'stop' }));
  await Promise.all([userClosed, techClosed]);

  // 7. La session a disparu
  const jgone = await fetch(`${BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: sess.code }),
  });
  assert.equal(jgone.status, 404, 'session supprimée après arrêt');

  // 8. Protections : accès technicien sans cookie / avec faux cookie
  const s2 = await (await fetch(`${BASE}/api/session`, { method: 'POST' })).json();
  await expectRejectedWS(`ws://127.0.0.1:3080/ws/tech?code=${s2.code}`);
  await expectRejectedWS(`ws://127.0.0.1:3080/ws/tech?code=${s2.code}`, { headers: { cookie: 'sid=faux' } });

  // 9. Protection : jeton utilisateur invalide -> fermeture
  const userBad = await wsOpen(`ws://127.0.0.1:3080/ws/user`);
  const badClosed = waitClose(userBad);
  userBad.send(JSON.stringify({ type: 'auth', token: '0'.repeat(64) }));
  await badClosed;

  console.log('OK — relais, authentification, limites et cycle de vie validés.');
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
    finish(1);
  });
