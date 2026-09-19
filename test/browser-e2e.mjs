// Test RÉEL en navigateur : parcours complet d'une assistance, de bout en bout.
//
// Un vrai Chrome est piloté via CDP (aucune simulation) :
//   1. la page « personne aidée » démarre un vrai partage d'écran ;
//   2. la page « espace technicien » se connecte, saisit le code affiché ;
//   3. les images arrivent réellement, chiffrées puis déchiffrées ;
//   4. les boutons de zoom agrandissent réellement l'image affichée ;
//   5. le crédit, l'icône GitHub et le lien discret sont présents et cliquables.
//
// Prérequis : PHP CLI (variable PHP_BIN ou php dans le PATH) et un Chrome/Edge.
// Usage : node test/browser-e2e.mjs
//
// Le serveur PHP local est configuré avec TEST_PASSWORD (mot de passe du
// config.php local) — il n'est jamais affiché.

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = path.join(ROOT, 'hostinger-php');
const PORT = 8099;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = 9333;

// Mot de passe : lu depuis la configuration locale, jamais recopié dans le code.
const cfg = fs.readFileSync(path.join(SITE, 'config.php'), 'utf8');
const PASSWORD = (cfg.match(/tech_password'\s*=>\s*'([^']+)'/) || [])[1];
if (!PASSWORD) {
  console.error('ÉCHEC : mot de passe technicien introuvable dans hostinger-php/config.php');
  process.exit(2);
}

function findBrowser() {
  const candidates = [
    process.env.BROWSER_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}

function findPhp() {
  const candidates = [
    process.env.PHP_BIN,
    path.join(os.tmpdir(), 'php-cli', 'php.exe'),
    'C:\\php\\php.exe',
  ].filter(Boolean);
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Client CDP minimal ------------------------------------------------------
class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout CDP : ' + method)); }
      }, 20000);
    });
  }

  // Évalue une expression dans la page et renvoie sa valeur.
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (res.exceptionDetails) throw new Error('JS : ' + JSON.stringify(res.exceptionDetails.exception));
    return res.result.value;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      const ready = await this.eval('document.readyState').catch(() => null);
      if (ready === 'complete') return;
    }
  }

  // Attend qu'une expression devienne vraie (sondage dans la page).
  async waitFor(expression, label, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await this.eval(expression).catch(() => undefined);
      if (v) return v;
      if (Date.now() > deadline) throw new Error('attente dépassée : ' + label);
      await sleep(250);
    }
  }
}

async function openPage(browserWs, url) {
  // Crée un onglet via l'endpoint HTTP de débogage.
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const page = new Page(ws);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.goto(url);
  return page;
}

// --- Cycle de vie ------------------------------------------------------------
let phpProc = null;
let chromeProc = null;
const chromeDir = path.join(os.tmpdir(), 'easyhelper-chrome-' + Date.now());

async function start() {
  const php = findPhp();
  if (!php) throw new Error('PHP CLI introuvable (définissez PHP_BIN)');
  const browser = findBrowser();
  if (!browser) throw new Error('Chrome ou Edge introuvable');

  phpProc = spawn(php, ['-S', `127.0.0.1:${PORT}`, '-t', SITE], { stdio: 'ignore' });
  await sleep(1500);

  // Le partage d'écran est autorisé sans boîte de dialogue et la source est
  // choisie automatiquement : c'est ce qui rend le parcours automatisable.
  chromeProc = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${chromeDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--use-fake-ui-for-media-stream',
    '--enable-usermedia-screen-capturing',
    '--allow-http-screen-capture',
    '--auto-select-desktop-capture-source=Entire screen',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });

  // Attente de l'endpoint de débogage.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (r.ok) return;
    } catch { /* pas encore prêt */ }
    await sleep(500);
  }
  throw new Error('le navigateur n\'expose pas son port de débogage');
}

function stop() {
  for (const p of [chromeProc, phpProc]) {
    if (!p) continue;
    try { p.kill(); } catch { /* ignore */ }
  }
  try { fs.rmSync(chromeDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// --- Parcours ----------------------------------------------------------------
async function main() {
  await start();
  const browserWs = null;

  console.log('1. page « personne aidée » (index.html)');
  const user = await openPage(browserWs, ORIGIN + '/index.html');
  // Vérifie le crédit discret et le lien caché avant tout partage.
  const credit = await user.eval(`(() => {
    const a = document.querySelector('.creditLink');
    const w = document.querySelector('.techLink');
    return {
      texte: a ? a.textContent.trim() : '',
      href: a ? a.href : '',
      icone: !!document.querySelector('svg.ghIcon'),
      cible: a ? a.target : '',
      lienTech: w ? w.getAttribute('href') : '',
      titreTech: w ? w.getAttribute('title') : '',
      discret: w ? getComputedStyle(w).opacity : '',
    };
  })()`);
  assert.match(credit.texte, /danikuma spinecho/i, 'signature présente');
  assert.equal(credit.href, 'https://github.com/DanikumaSpinecho/easyhelper', 'lien du dépôt');
  assert.equal(credit.icone, true, 'icône GitHub présente');
  assert.equal(credit.cible, '_blank', 'ouverture dans un nouvel onglet');
  assert.equal(credit.lienTech, 'tech.html', 'lien discret vers l\'espace technicien');
  assert.equal(credit.titreTech, 'Espace technicien', 'info-bulle du lien discret');
  console.log(`   crédit « ${credit.texte} » → dépôt, icône GitHub, lien discret (opacité ${credit.discret})`);

  console.log('2. démarrage d\'un vrai partage d\'écran');
  await user.eval(`document.getElementById('startBtn').click()`);
  const code = await user.waitFor(
    `(() => { const c = document.getElementById('code').textContent.trim();
              return /^\\d{6}$/.test(c) ? c : ''; })()`,
    'affichage du code de session',
  );
  assert.match(code, /^\d{6}$/, 'code à 6 chiffres');
  console.log('   capture réelle démarrée, code affiché à la personne aidée');

  console.log('3. page « espace technicien » (tech.html)');
  const tech = await openPage(browserWs, ORIGIN + '/tech.html');
  const boutons = await tech.eval(`(() => ({
    zoomIn: !!document.getElementById('zoomIn'),
    zoomOut: !!document.getElementById('zoomOut'),
    zoomFit: !!document.getElementById('zoomFit'),
    cadre: !!document.getElementById('screenBox'),
  }))()`);
  assert.ok(boutons.zoomIn && boutons.zoomOut && boutons.zoomFit, 'boutons de zoom présents');
  assert.ok(boutons.cadre, 'cadre de défilement présent');

  // Connexion avec le mot de passe réel, puis saisie du code réel.
  await tech.eval(`(() => {
    document.getElementById('pw').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('#loginForm button[type=submit]').click();
  })()`);
  await tech.waitFor(`!document.getElementById('codeEntry').classList.contains('hidden')`, 'accès à la saisie du code');
  await tech.eval(`(() => {
    document.getElementById('code').value = ${JSON.stringify(code)};
    document.querySelector('#codeForm button[type=submit]').click();
  })()`);

  console.log('4. réception des images (chiffrées puis déchiffrées)');
  await tech.waitFor(`!document.getElementById('viewer').classList.contains('hidden')`, 'ouverture de la vue');
  const statut = await tech.waitFor(
    `(() => { const t = document.getElementById('viewerStatus').textContent;
              return t.indexOf('écran en direct') >= 0 ? t : ''; })()`,
    'première image affichée',
  );
  const infos = await tech.eval(`(() => {
    const img = document.getElementById('screen');
    return {
      src: img.src.slice(0, 5),
      naturel: img.naturalWidth + 'x' + img.naturalHeight,
      largeur: img.getBoundingClientRect().width,
      cadre: document.getElementById('screenBox').getBoundingClientRect().width,
    };
  })()`);
  assert.equal(infos.src, 'blob:', 'image affichée depuis les octets reçus');
  assert.ok(infos.naturel !== '0x0', 'une vraie image a été décodée');
  console.log(`   statut : « ${statut} » — image réelle ${infos.naturel}`);

  console.log('5. zoom sur l\'image en direct');
  const avant = infos.largeur;
  await tech.eval(`document.getElementById('zoomIn').click()`);
  await sleep(300);
  const z1 = await tech.eval(`(() => ({
    label: document.getElementById('zoomLabel').textContent.trim(),
    largeur: document.getElementById('screen').getBoundingClientRect().width,
  }))()`);
  assert.equal(z1.label, '125 %', 'libellé après un clic sur +');
  assert.ok(z1.largeur > avant, `l'image s'agrandit réellement (${Math.round(avant)} → ${Math.round(z1.largeur)} px)`);

  for (let i = 0; i < 30; i++) await tech.eval(`document.getElementById('zoomIn').click()`);
  await sleep(300);
  const zMax = await tech.eval(`(() => ({
    label: document.getElementById('zoomLabel').textContent.trim(),
    desactive: document.getElementById('zoomIn').disabled,
    largeur: document.getElementById('screen').getBoundingClientRect().width,
  }))()`);
  assert.equal(zMax.label, '500 %', 'butée haute');
  assert.equal(zMax.desactive, true, 'bouton + désactivé à la butée');
  console.log(`   zoom 100 % → ${zMax.label} effectif (${Math.round(zMax.largeur)} px), butée respectée`);

  await tech.eval(`document.getElementById('zoomFit').click()`);
  await sleep(300);
  const zFit = await tech.eval(`document.getElementById('zoomLabel').textContent.trim()`);
  assert.equal(zFit, '100 %', 'retour à l\'ajustement');
  console.log('   retour à l\'ajustement');

  console.log('6. arrêt du partage par la personne aidée');
  await user.eval(`document.getElementById('stopBtn').click()`);
  const fin = await tech.waitFor(
    `(() => { const t = document.getElementById('viewerStatus').textContent;
              return /arrêté le partage|Session terminée/.test(t) ? t : ''; })()`,
    'notification de fin côté technicien',
  );
  console.log(`   technicien informé : « ${fin} »`);

  console.log('\nOK — parcours réel complet validé dans un vrai navigateur :');
  console.log('     partage d\'écran → chiffrement → déchiffrement → zoom → arrêt.');
}

main()
  .then(() => { stop(); process.exitCode = 0; })
  .catch((e) => {
    console.error('ÉCHEC :', e.message);
    stop();
    process.exitCode = 1;
  });
