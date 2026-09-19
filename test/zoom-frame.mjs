// Cadre de la vue technicien : le zoom doit agrandir l'IMAGE dans un cadre de
// taille FIXE, avec des ascenseurs pour parcourir le contenu — et non étirer le
// cadre ni la page. C'est ce qui permet de relire rapidement un écran agrandi.
//
// Mesure réelle dans un navigateur (CDP), à 100 % puis à 500 % :
//   - hauteur du cadre inchangée entre les deux ;
//   - hauteur de page inchangée (le zoom ne pousse pas le bas de page) ;
//   - ascenseurs horizontal ET vertical présents en zoom ;
//   - largeur de l'image effectivement multipliée.
//
// Usage : node test/zoom-frame.mjs

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = path.join(ROOT, 'hostinger-php');
const PORT = 8097;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = 9331;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findExe(list) {
  for (const c of list) { if (c && fs.existsSync(c)) return c; }
  return null;
}

const browser = findExe([
  process.env.BROWSER_BIN,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]);
const php = findExe([process.env.PHP_BIN, path.join(os.tmpdir(), 'php-cli', 'php.exe')]);

class Page {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout CDP ' + method)); }
      }, 20000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
}

let phpProc = null, chromeProc = null;
const profile = path.join(os.tmpdir(), 'easyhelper-zoom-' + Date.now());

async function main() {
  assert.ok(browser, 'Chrome ou Edge introuvable');
  assert.ok(php, 'PHP CLI introuvable');

  phpProc = spawn(php, ['-S', `127.0.0.1:${PORT}`, '-t', SITE], { stdio: 'ignore' });
  await sleep(1500);
  chromeProc = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok) break; } catch { /* attente */ }
    await sleep(500);
  }

  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(ORIGIN + '/tech.html')}`, { method: 'PUT' });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const page = new Page(ws);
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: ORIGIN + '/tech.html' });
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    if ((await page.eval('document.readyState').catch(() => '')) === 'complete') break;
  }

  // Une image d'écran réaliste (800×500 comme la capture réelle). Toute la
  // mesure se fait dans UN SEUL appel : révéler la vue, charger l'image,
  // régler le zoom et mesurer. C'est indispensable car la page se masque
  // toute seule pendant que le serveur répond à la vérification de session —
  // mesurer dans un second appel donnerait des dimensions nulles (cadre caché)
  // et ferait croire à un défaut de mise en page qui n'existe pas.
  async function measureAt(clicks) {
    return page.eval(`(async () => {
      const img = document.getElementById('screen');
      const box = document.getElementById('screenBox');
      document.getElementById('viewer').classList.remove('hidden');
      if (!img.dataset.pret) {
        img.src = 'data:image/svg+xml,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">' +
          '<rect width="800" height="500" fill="#e2e8f0"/></svg>');
        await new Promise((r) => {
          if (img.complete && img.naturalWidth) return r();
          img.addEventListener('load', () => r(), { once: true });
          img.addEventListener('error', () => r(), { once: true });
        });
        img.dataset.pret = '1';
      }
      document.getElementById('zoomFit').click();
      for (let i = 0; i < ${clicks}; i++) document.getElementById('zoomIn').click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = box.getBoundingClientRect();
      return {
        visible: r.width > 0,
        frameW: Math.round(r.width), frameH: Math.round(r.height),
        clientW: box.clientWidth, clientH: box.clientHeight,
        scrollW: box.scrollWidth, scrollH: box.scrollHeight,
        imgW: Math.round(img.getBoundingClientRect().width),
        imgH: Math.round(img.getBoundingClientRect().height),
        pageH: document.documentElement.scrollHeight,
        label: document.getElementById('zoomLabel').textContent.trim(),
        hScroll: box.scrollWidth > box.clientWidth + 1,
        vScroll: box.scrollHeight > box.clientHeight + 1,
      };
    })()`);
  }

  const avant = await measureAt(0);
  console.log('à 100 % :', JSON.stringify(avant));

  const apres = await measureAt(16);
  console.log('à 500 % :', JSON.stringify(apres));

  const label = apres.label;
  console.log('libellé :', label);

  const alertes = [];
  if (!avant.visible || !apres.visible) alertes.push('la vue a été masquée pendant la mesure');
  if (label !== '500 %') alertes.push(`libellé inattendu (${label})`);
  // Invariant exact : l'image fait « zoom » % de la largeur UTILE du cadre.
  // On compare à clientWidth (et non à la largeur du cadre) car l'apparition
  // de l'ascenseur vertical rétrécit la zone de contenu — c'est le signe que
  // le défilement se fait bien à l'intérieur du cadre.
  const attendu = 5 * apres.clientW;
  if (Math.abs(apres.imgW - attendu) > attendu * 0.05) {
    alertes.push(`largeur d'image incohérente avec le zoom (${apres.imgW} px au lieu de ~${attendu})`);
  }
  if (Math.abs(avant.imgW - avant.clientW) > 2) {
    alertes.push(`à 100 %, l'image ne remplit pas la largeur (${avant.imgW} vs ${avant.clientW})`);
  }
  if (apres.frameW !== avant.frameW) {
    alertes.push(`le cadre change de largeur (${avant.frameW} → ${apres.frameW} px)`);
  }
  if (Math.abs(apres.frameH - avant.frameH) > 2) {
    alertes.push(`le CADRE s'étire avec le zoom (${avant.frameH} → ${apres.frameH} px) — il doit rester fixe et laisser l'image défiler`);
  }
  if (Math.abs(apres.pageH - avant.pageH) > 2) {
    alertes.push(`la PAGE s'allonge avec le zoom (${avant.pageH} → ${apres.pageH} px)`);
  }
  if (!apres.hScroll) alertes.push("pas d'ascenseur horizontal en zoom");
  if (!apres.vScroll) alertes.push("pas d'ascenseur vertical en zoom");

  if (alertes.length) {
    console.log('\nÉCHEC — le cadre ne se comporte pas comme une fenêtre :');
    for (const a of alertes) console.log('  - ' + a);
    process.exitCode = 1;
  } else {
    console.log('\nOK — cadre de taille fixe, image agrandie, ascenseurs présents.');
  }
}

main()
  .catch((e) => { console.error('ÉCHEC :', e.message); process.exitCode = 1; })
  .finally(() => {
    for (const p of [chromeProc, phpProc]) { if (p) { try { p.kill(); } catch { /* ignore */ } } }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  });
