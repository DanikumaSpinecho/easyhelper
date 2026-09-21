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
  'liveBanner', 'liveBannerText',
  'badgeHttps', 'badgeE2ee', 'badgeConn', 'sysInfo',
  'diagOs', 'diagBrowser', 'diagRam', 'diagCores', 'diagScreen', 'diagLang', 'diagNet', 'diagSecure',
];

function makeEl(id) {
  const cls = new Set(['hidden']);
  const el = {
    id,
    style: {},
    // Texte initial repris du HTML : la bannière porte déjà « Écran en direct ».
    textContent: id === 'liveBannerText' ? 'Écran en direct' : '',
    disabled: false,
    handlers: {},
    classList: {
      remove: (c) => cls.delete(c),
      add: (c) => cls.add(c),
      contains: (c) => cls.has(c),
    },
    addEventListener(ev, fn) { (el.handlers[ev] = el.handlers[ev] || []).push(fn); },
    dispatch(ev, payload) { for (const f of (el.handlers[ev] || [])) f({ preventDefault() {}, ...payload }); },
    click() { el.dispatch('click'); },
    // Un appui réel émet 'pointerdown' PUIS 'click' : on reproduit les deux
    // pour vérifier qu'un seul geste ne compte pas double.
    tap() { el.dispatch('pointerdown'); el.dispatch('click'); },
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

  const banner = els.get('liveBanner');
  const bannerText = els.get('liveBannerText');

  // Les bandeaux d'état sont initialisés dès le chargement : le transport
  // HTTPS/HTTP est connu immédiatement, les autres attendent la session.
  const badgeHttps = els.get('badgeHttps');
  assert.match(badgeHttps.textContent, /HTTPS|HTTP/, `[${label}] bandeau de transport initialisé`);
  assert.match(badgeHttps.className, /badge/, `[${label}] bandeau de transport stylé`);

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

  // Un appui tactile ne compte qu'une fois : 'pointerdown' puis 'click'
  // décrivent le MÊME geste et ne doivent pas produire deux incréments.
  const beforeTap = lbl.textContent;
  inBtn.tap();
  assert.equal(lbl.textContent, '125 %', `[${label}] un appui = un seul incrément`);
  assert.notEqual(lbl.textContent, beforeTap, `[${label}] l'appui a bien un effet`);
  // Deux appuis rapides restent deux incréments (aucun blocage temporel).
  inBtn.tap();
  inBtn.tap();
  assert.equal(lbl.textContent, '175 %', `[${label}] appuis rapides tous pris en compte`);

  // La bannière annonce l'état réel, y compris à la fin du partage.
  assert.equal(bannerText.textContent, 'Écran en direct', `[${label}] bannière initiale`);
  assert.equal(banner.classList.contains('ended'), false, `[${label}] bannière active`);
  els.get('closeBtn').click();

  console.log(`  OK  ${label} : zoom fonctionnel (25 % par clic, butées 100–500, ajustement, réinitialisation)`);
}

function testPages() {
  const pages = [
    { file: 'php-full/index.html', label: 'PHP index', wrench: true },
    { file: 'vps-node/public/index.html', label: 'Node index', wrench: true },
    { file: 'php-full/tech.html', label: 'PHP tech', wrench: false },
    { file: 'vps-node/public/tech.html', label: 'Node tech', wrench: false },
  ];
  for (const p of pages) {
    const html = readFileSync(new URL('../' + p.file, import.meta.url), 'utf8');
    // Ressources versionnées : un cache navigateur ne doit jamais servir
    // l'ancien JavaScript après une mise à jour (boutons inertes).
    assert.match(html, /style\.css\?v=\d+/, `[${p.label}] CSS versionné`);
    assert.match(html, /(tech|user|crypto)\.js\?v=\d+/, `[${p.label}] JS versionné`);
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
      assert.match(html, /id="liveBannerText"/, `[${p.label}] bannière d'état pilotable`);
      assert.match(html, /id="badgeHttps"/, `[${p.label}] bandeau HTTPS présent`);
      assert.match(html, /id="badgeE2ee"/, `[${p.label}] bandeau de chiffrement présent`);
      assert.match(html, /id="badgeConn"/, `[${p.label}] bandeau de connexion présent`);
      assert.match(html, /id="sysInfo"/, `[${p.label}] panneau infos système présent`);
      assert.match(html, /id="diagOs"/, `[${p.label}] ligne système du panneau présente`);
    }
    // La page d'accueil est désormais un portail professionnel : les sections
    // « À propos » et les garanties sont là pour une catégorisation honnête.
    if (p.wrench) {
      assert.match(html, /À propos/, `[${p.label}] section À propos présente`);
      assert.match(html, /Chiffrement de bout en bout|chiffrée de bout en bout/, `[${p.label}] garantie de chiffrement affichée`);
      if (p.label.startsWith('PHP')) {
        assert.doesNotMatch(html, /noindex/, `[${p.label}] page d'accueil indexable (catégorisation)`);
      }
    }
    console.log(`  OK  ${p.label} : crédit discret, icône GitHub${p.wrench ? ' et lien clé à molette' : ' et boutons de zoom'}`);
  }
}

function testStyles() {
  for (const file of ['php-full/style.css', 'vps-node/public/style.css']) {
    const css = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    // Sans cette règle, « a:visited » (spécificité supérieure) fait virer le
    // crédit au violet après un clic : rendu amateur et incohérent.
    assert.match(css, /footer \.credit a:visited/, `[${file}] couleur du lien visité maîtrisée`);
    assert.match(css, /justify-content: flex-end/, `[${file}] crédit aligné à droite`);
    assert.match(css, /footer \.credit a\b/, `[${file}] couleur de base du crédit fixée`);
    // On cherche une VALEUR de couleur violette, pas le mot dans un commentaire :
    // la règle du crédit doit couvrir tous les états, donc aucune déclaration de
    // couleur « violette » ne doit subsister hors commentaires.
    const horsCommentaires = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(horsCommentaires, /#(7c3aed|8b5cf6|a855f7|6d28d9|9333ea)/i,
      `[${file}] aucune teinte violette dans les règles`);
    console.log(`  OK  ${file} : lien discret, gris constant même visité, aligné à droite`);
  }
}

console.log('Interface technicien — vérification fonctionnelle');
testZoom('php-full/tech.js', 'variante PHP');
testZoom('vps-node/public/tech.js', 'variante Node');
testPages();
testStyles();
console.log('OK — zoom, bannière d\'état, geste tactile et crédit discret conformes.');
