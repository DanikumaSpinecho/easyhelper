// Page technicien : authentification, saisie du code, visionneuse en lecture seule
// (version hébergement mutualisé : long-polling sur api.php?action=fetch).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');
  const setStatus = (el, text) => { el.textContent = text; if (text) show(el); else hide(el); };
  const API = 'api.php';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const viewerStatus = $('viewerStatus');
  const closeBtn = $('closeBtn');
  const logoutBtn = $('logoutBtn');

  let controller = null;
  let objectUrl = null;
  let endMsg = null;

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
    let res;
    try {
      res = await fetch(API + '?action=join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    } catch {
      setStatus(joinStatus, 'Impossible de contacter le serveur.');
      return;
    }
    if (res.status === 404) { setStatus(joinStatus, 'Code inconnu ou session déjà terminée.'); return; }
    if (res.status === 401) { refreshAuth(); return; }
    if (!res.ok) { setStatus(joinStatus, 'Erreur (' + res.status + '). Réessayez.'); return; }
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
          if (ct.indexOf('image/jpeg') === 0) {
            after = parseInt(res.headers.get('X-Frame-Id') || String(after), 10);
            setStatus(viewerStatus, 'Connecté — écran en direct.');
            const buf = await res.arrayBuffer();
            if (controller) renderFrame(buf);
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

  function renderFrame(buf) {
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
    screenImg.src = url;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = url;
  }

  closeBtn.addEventListener('click', () => closeViewer());
  logoutBtn.addEventListener('click', async () => {
    try { await fetch(API + '?action=logout', { method: 'POST' }); } catch { /* ignore */ }
    closeViewer();
    refreshAuth();
  });

  // Lien direct possible : tech.html#code=123456
  const m = location.hash.match(/code=(\d{6})/);
  if (m) codeInput.value = m[1];

  refreshAuth();
})();
