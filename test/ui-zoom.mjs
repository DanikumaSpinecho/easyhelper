// Test fonctionnel de l'interface technicien : boutons de zoom, crédit et lien
// discret vers l'espace technicien.
//
// Le VRAI tech.js est exécuté dans un DOM minimal ; on clique réellement sur les
// boutons et on vérifie que l'image change de largeur, que la butée fonctionne et
// que l'état des boutons suit. Les pages HTML sont ensuite inspectées pour
// vérifier la présence du crédit, de l'icône GitHub et du lien discret.
//
// Usage : node test/ui-zoom.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const IDS = [
  'login', 'codeEntry', 'viewer', 'loginForm', 'pw', 'loginStatus',
  'codeForm', 'code', 'joinStatus', 'screen', 'screenBox', 'zoomIn',
  'zoomOut', 'zoomFit', 'zoomLabel', 'viewerStatus', 'closeBtn', 'logoutBtn',
];

function makeEl(id) {
  const cls = new Set(['hidden']);
  const el = {
    id,
    style: {},
    textContent: '',
    disabled: false,
    handlers: {},
    classList: {
      remove: (c) => cls.delete(c),
      add: (c) => cls.add(c),
      contains: (c) => cls.has(c),
    },
    addEventListener(ev, fn) { (el.handlers[ev] = el.handlers[ev] || []).push(fn); },
    click() { for (const f of (el.handlers.click || [])) f({ preventDefault() {} }); },
    scrollTo() {},
  };
  return el;
}

// Exécute un tech.js réel dans un environnement navigateur minimal.
function loadTech(jsPath) {
  const src = readFileSync(new URL('../' + jsPath, import.meta.url), 'utf8');
  const els = new Map(IDS.map((id) => [id, makeEl(id)]));
  const document = { getElementById: (id) => els.get(id) || null };
  const location = { protocol: 'https:', host: 'example.org', hash: '' };
  const run = new Function(
    'window', 'document', 'location', 'fetch', 'AbortController', 'URL', 'Blob', 'setTimeout',
    'clearTimeout', 'navigator',
    src,
  );
  run(
    { EHCrypto: { available: false } },
    document,
    location,
    () => Promise.reject(new Error('réseau simulé')),
    class { constructor() { this.signal = null; } abort() {} },
    URL,
    Blob,
    setTimeout,
    clearTimeout,
    { mediaDevices: {} },
  );
  return els;
}

function testZoom(jsPath, label) {
  const els = loadTech(jsPath);
  const img = els.get('screen');
  const lbl = els.get('zoomLabel');
  const inBtn = els.get('zoomIn');
  const outBtn = els.get('zoomOut');
  const fitBtn = els.get('zoomFit');
  const box = els.get('screenBox');

  // État initial : ajusté à la largeur, réduction impossible.
  assert.equal(lbl.textContent, '100 %', `[${label}] libellé initial`);
  assert.equal(img.style.width, '100%', `[${label}] largeur initiale appliquée`);
  assert.equal(outBtn.disabled, true, `[${label}] « − » désactivé à 100 %`);
  assert.equal(inBtn.disabled, false, `[${label}] « + » actif à 100 %`);

  // Un clic sur « + » agrandit réellement l'image.
  inBtn.click();
  assert.equal(lbl.textContent, '125 %', `[${label}] après un clic sur +`);
  assert.equal(img.style.width, '125%', `[${label}] largeur transmise à l'image`);
  assert.equal(outBtn.disabled, false, `[${label}] « − » réactivé`);

  // Plusieurs clics montent jusqu'à la butée, puis restent bloqués.
  for (let i = 0; i < 40; i++) inBtn.click();
  assert.equal(lbl.textContent, '500 %', `[${label}] butée haute atteinte`);
  assert.equal(img.style.width, '500%', `[${label}] largeur plafonnée`);
  assert.equal(inBtn.disabled, true, `[${label}] « + » désactivé à la butée`);

  // La réduction fonctionne et redescend jusqu'à la butée basse.
  outBtn.click();
  assert.equal(lbl.textContent, '475 %', `[${label}] après un clic sur −`);
  for (let i = 0; i < 40; i++) outBtn.click();
  assert.equal(lbl.textContent, '100 %', `[${label}] butée basse atteinte`);
  assert.equal(outBtn.disabled, true, `[${label}] « − » désactivé à la butée basse`);

  // « Ajuster » revient à la largeur du cadre.
  inBtn.click();
  inBtn.click();
  assert.equal(lbl.textContent, '150 %', `[${label}] zoom intermédiaire`);
  fitBtn.click();
  assert.equal(lbl.textContent, '100 %', `[${label}] retour à l'ajustement`);
  assert.equal(img.style.width, '100%', `[${label}] largeur ajustée rétablie`);

  // Le cadre de l'image existe (c'est lui qui défile quand l'image est zoomée).
  assert.ok(box, `[${label}] cadre de défilement présent`);

  // Fermer la vue remet le zoom à l'ajustement.
  inBtn.click();
  els.get('closeBtn').click();
  assert.equal(lbl.textContent, '100 %', `[${label}] zoom réinitialisé à la fermeture`);

  console.log(`  OK  ${label} : zoom fonctionnel (25 % par clic, butées 100–500, ajustement, réinitialisation)`);
}

function testPages() {
  const pages = [
    { file: 'hostinger-php/index.html', label: 'PHP index', wrench: true },
    { file: 'public/index.html', label: 'Node index', wrench: true },
    { file: 'hostinger-php/tech.html', label: 'PHP tech', wrench: false },
    { file: 'public/tech.html', label: 'Node tech', wrench: false },
  ];
  for (const p of pages) {
    const html = readFileSync(new URL('../' + p.file, import.meta.url), 'utf8');
    // Crédit discret : auteur + icône GitHub + lien vers le dépôt.
    assert.match(html, /danikuma spinecho/, `[${p.label}] signature présente`);
    assert.match(html, /href="https:\/\/github\.com\/DanikumaSpinecho\/easyhelper"/,
      `[${p.label}] lien vers le dépôt présent`);
    assert.match(html, /rel="noopener noreferrer"/, `[${p.label}] ouverture sécurisée du lien`);
    assert.match(html, /class="ghIcon"/, `[${p.label}] icône GitHub présente`);
    if (p.wrench) {
      assert.match(html, /class="techLink" href="tech\.html"/, `[${p.label}] lien discret vers l'espace technicien`);
    } else {
      assert.match(html, /id="zoomIn"/, `[${p.label}] bouton zoom + présent`);
      assert.match(html, /id="zoomOut"/, `[${p.label}] bouton zoom − présent`);
      assert.match(html, /id="zoomFit"/, `[${p.label}] bouton d'ajustement présent`);
      assert.match(html, /id="screenBox"/, `[${p.label}] cadre de défilement présent`);
    }
    console.log(`  OK  ${p.label} : crédit discret, icône GitHub${p.wrench ? ' et lien clé à molette' : ' et boutons de zoom'}`);
  }
}

console.log('Interface technicien — vérification fonctionnelle');
testZoom('hostinger-php/tech.js', 'variante PHP');
testZoom('public/tech.js', 'variante Node');
testPages();
console.log('OK — zoom fonctionnel et éléments discrets conformes dans les deux variantes.');
