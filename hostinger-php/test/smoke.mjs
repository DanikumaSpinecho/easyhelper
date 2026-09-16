// Test de bout en bout du relais PHP (sans navigateur).
// Local  : php -S 127.0.0.1:8080 -t hostinger-php   (PHP >= 7.4)
//          $env:TEST_PASSWORD='***'; node hostinger-php/test/smoke.mjs
// Déployé : $env:BASE='https://support.spinecho.fr'; $env:TEST_PASSWORD='***'; node hostinger-php/test/smoke.mjs

import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const PASSWORD = process.env.TEST_PASSWORD || '';
if (!PASSWORD) {
  console.error('Définissez TEST_PASSWORD (mot de passe technicien configuré).');
  process.exitCode = 2;
  process.exit();
}

const API = `${BASE}/api.php`;

async function main() {
  // 0. Diagnostic d'installation
  let r = await fetch(`${API}?action=selftest`);
  assert.equal(r.status, 200, 'selftest');
  const st = await r.json();
  assert.equal(st.password_configured, true, 'mot de passe configuré');
  assert.equal(st.data_writable, true, 'dossier data inscriptible');

  // 1. Création de session
  r = await fetch(`${API}?action=create`, { method: 'POST' });
  assert.equal(r.status, 200, 'create');
  const sess = await r.json();
  assert.match(sess.code, /^\d{6}$/, 'code à 6 chiffres');
  assert.ok(/^[0-9a-f]{64}$/.test(sess.token), 'jeton utilisateur 256 bits');

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

  // 3. Vérification du code de session
  r = await fetch(`${API}?action=join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: sess.code }),
  });
  assert.equal(r.status, 200, 'join');
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

  // 5. Upload d'une image puis récupération par le technicien
  const frame = Buffer.alloc(30000, 7);
  const upHeaders = { 'X-Code': sess.code, 'X-Token': sess.token, 'Content-Type': 'image/jpeg' };
  r = await fetch(`${API}?action=upload`, { method: 'POST', headers: upHeaders, body: frame });
  assert.equal(r.status, 200, 'upload');
  const up = await r.json();
  assert.equal(up.frameId, 1, 'frameId 1');

  r = await fetch(`${API}?action=fetch&code=${sess.code}&after=0`, { headers: { cookie } });
  assert.equal(r.status, 200, 'fetch');
  assert.ok((r.headers.get('content-type') || '').includes('image/jpeg'), 'type image/jpeg');
  assert.equal(r.headers.get('x-frame-id'), '1', 'x-frame-id 1');
  const got = Buffer.from(await r.arrayBuffer());
  assert.equal(got.length, frame.length, 'taille de l\u2019image préservée');
  assert.equal(got[0], 7, 'contenu de l\u2019image préservé');

  // 6. Cadence limitée côté serveur (2e upload immédiat)
  r = await fetch(`${API}?action=upload`, { method: 'POST', headers: upHeaders, body: frame });
  assert.ok(r.status === 200 || r.status === 429, '2e upload immédiat accepté ou limité');
  if (r.status === 200) {
    const up2 = await r.json();
    assert.equal(up2.frameId, 2, 'frameId 2');
  }

  // 7. Arrêt par l'utilisateur -> session terminée
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

  // 8. Image trop grande refusée
  const s2 = await (await fetch(`${API}?action=create`, { method: 'POST' })).json();
  r = await fetch(`${API}?action=upload`, {
    method: 'POST',
    headers: { 'X-Code': s2.code, 'X-Token': s2.token },
    body: Buffer.alloc(300000, 1),
  });
  assert.equal(r.status, 413, 'image trop grande refusée');

  console.log('OK — relais PHP, authentification, limites et cycle de vie validés.');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => {
    console.error('ÉCHEC :', e.message);
    process.exitCode = 1;
  });
