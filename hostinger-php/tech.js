// Page technicien : authentification, saisie du code, visionneuse en lecture seule.
// Version hébergement mutualisé (long-polling) avec déchiffrement de bout en bout :
// les images reçues sont déchiffrées dans ce navigateur (ECDH P-256 + AES-256-GCM),
// le serveur ne les ayant jamais vues en clair.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');
  const setStatus = (el, text) => { el.textContent = text; if (text) show(el); else hide(el); };
  const API = 'api.php';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cryptoApi = window.EHCrypto || { available: false };

  const loginCard = $('login');
  const codeCard = $('codeEntry');
  const viewer = $('viewer');
  const loginForm = $('loginForm');
  const pwInput = $('pw');
  const loginStatus = $('loginStatus');
  const codeForm = $('codeForm');
  const codeInput = $('code');
  const joinStatus = $('joinStatus');
  const screenImg = $('screen');
  const screenBox = $('screenBox');
  const zoomInBtn = $('zoomIn');
  const zoomOutBtn = $('zoomOut');
  const zoomFitBtn = $('zoomFit');
  const zoomLabel = $('zoomLabel');
  const viewerStatus = $('viewerStatus');
  const closeBtn = $('closeBtn');
  const logoutBtn = $('logoutBtn');

  let controller = null;
  let objectUrl = null;
  let endMsg = null;
  let encryptedSession = false;

  // Zoom de la vue (100 % = ajusté à la largeur). L'image zoomée défile dans
  // le cadre : la page n'est jamais étirée.
  const ZOOM_MIN = 100;
  const ZOOM_MAX = 500;
  const ZOOM_STEP = 25;
  const ZOOM_FIT = 100;
  let zoom = ZOOM_FIT;

  async function refreshAuth() {
    let authed = false;
    try {
      const res = await fetch(API + '?action=me');
      const j = await res.json();
      authed = !!(j && j.ok);
    } catch { /* serveur injoignable */ }
    if (authed) { hide(loginCard); show(codeCard); }
    else { show(loginCard); hide(codeCard); hide(viewer); }
  }

  function closeViewer(backToCode = true) {
    if (controller) { controller.abort(); controller = null; }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    endMsg = null;
    encryptedSession = false;
    setZoom(ZOOM_FIT);
    hide(viewer);
    if (backToCode) show(codeCard);
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus(loginStatus, '');
    let res;
    try {
      res = await fetch(API + '?action=login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwInput.value }),
      });
    } catch {
      setStatus(loginStatus, 'Impossible de contacter le serveur.');
      return;
    }
    pwInput.value = '';
    if (res.ok) { hide(loginCard); show(codeCard); return; }
    if (res.status === 429) setStatus(loginStatus, 'Trop de tentatives. Réessayez dans quelques minutes.');
    else if (res.status === 503) setStatus(loginStatus, 'Service non configuré (voir config.php).');
    else setStatus(loginStatus, 'Mot de passe incorrect.');
  });

  codeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus(joinStatus, '');
    const code = codeInput.value.replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) { setStatus(joinStatus, 'Le code comporte 6 chiffres.'); return; }

    // Notre clé publique éphémère accompagne la vérification du code : elle sera
    // transmise à la personne aidée, qui chiffrera pour nous seul.
    const techPub = cryptoApi && cryptoApi.available ? await cryptoApi.pubkey() : '';
    let res;
    try {
      res = await fetch(API + '?action=join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, techPub }),
      });
    } catch {
      setStatus(joinStatus, 'Impossible de contacter le serveur.');
      return;
    }
    if (res.status === 404) { setStatus(joinStatus, 'Code inconnu ou session déjà terminée.'); return; }
    if (res.status === 401) { refreshAuth(); return; }
    if (!res.ok) { setStatus(joinStatus, 'Erreur (' + res.status + '). Réessayez.'); return; }

    let info = null;
    try { info = await res.json(); } catch { /* ignore */ }
    if (info && info.crypto === 'ecdh-p256-aesgcm' && info.userPub) {
      const key = await cryptoApi.derive(info.userPub, info.salt || '');
      encryptedSession = !!key;
    }
    openViewer(code);
  });

  function openViewer(code) {
    controller = new AbortController();
    endMsg = null;
    hide(codeCard);
    show(viewer);
    setStatus(viewerStatus, 'Connexion — attente des premières images…');
    pollLoop(code, 0);
  }

  async function pollLoop(code, after) {
    let retries = 0;
    for (;;) {
      if (!controller) return;
      try {
        const res = await fetch(
          API + '?action=fetch&code=' + encodeURIComponent(code) + '&after=' + after,
          { signal: controller.signal },
        );
        if (res.status === 204) { retries = 0; continue; } // attente longue côté serveur : on reboucle
        if (res.status === 200) {
          const ct = res.headers.get('Content-Type') || '';
          if (ct.indexOf('image/jpeg') === 0 || ct.indexOf('application/octet-stream') === 0) {
            after = parseInt(res.headers.get('X-Frame-Id') || String(after), 10);
            const buf = await res.arrayBuffer();
            if (!controller) return;
            if (ct.indexOf('application/octet-stream') === 0) {
              if (!cryptoApi.available || typeof cryptoApi.decryptFrame !== 'function') {
                setStatus(viewerStatus, 'Image protégée : ce navigateur ne prend pas en charge le déchiffrement.');
                retries = 0;
                continue;
              }
              const plain = await cryptoApi.decryptFrame(new Uint8Array(buf));
              if (!plain) {
                setStatus(viewerStatus, 'Image protégée — déchiffrement en cours…');
                retries = 0;
                continue;
              }
              setStatus(viewerStatus, 'Connecté — écran en direct (chiffré de bout en bout).');
              renderFrame(plain);
            } else {
              setStatus(viewerStatus, 'Connecté — écran en direct.');
              renderFrame(new Uint8Array(buf));
            }
            retries = 0;
            continue;
          }
          const j = await res.json().catch(() => null);
          if (j && j.state === 'ended') { endedMsg(j.reason); return; }
          retries = 0;
          continue;
        }
        if (res.status === 401) {
          closeViewer();
          refreshAuth();
          return;
        }
        if (res.status === 404) { endedMsg('Session introuvable ou déjà terminée.'); return; }
        retries++;
        if (retries > 4) { endedMsg('Connexion au serveur perdue.'); return; }
        await sleep(1000 * retries);
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        retries++;
        if (retries > 4) { endedMsg('Connexion au serveur perdue.'); return; }
        await sleep(1000 * retries);
      }
    }
  }

  function endedMsg(reason) {
    endMsg = reason === 'user-stopped'
      ? 'La personne aidée a arrêté le partage.'
      : 'Session terminée (' + reason + ').';
    setStatus(viewerStatus, endMsg);
  }

  function renderFrame(bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    screenImg.src = url;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = url;
  }

  // Largeur de l'image exprimée en pourcentage du cadre : 100 % l'ajuste, les
  // valeurs supérieures agrandissent et font apparaître les barres de défilement.
  function applyZoom() {
    screenImg.style.width = zoom + '%';
    zoomLabel.textContent = zoom + ' %';
    zoomOutBtn.disabled = zoom <= ZOOM_MIN;
    zoomInBtn.disabled = zoom >= ZOOM_MAX;
  }

  function setZoom(next) {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    applyZoom();
  }

  zoomInBtn.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
  zoomOutBtn.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
  zoomFitBtn.addEventListener('click', () => { setZoom(ZOOM_FIT); screenBox.scrollTo(0, 0); });

  closeBtn.addEventListener('click', () => closeViewer());
  logoutBtn.addEventListener('click', async () => {
    try { await fetch(API + '?action=logout', { method: 'POST' }); } catch { /* ignore */ }
    closeViewer();
    refreshAuth();
  });

  // Lien direct possible : tech.html#code=123456
  const m = location.hash.match(/code=(\d{6})/);
  if (m) codeInput.value = m[1];

  applyZoom();
  refreshAuth();
})();
