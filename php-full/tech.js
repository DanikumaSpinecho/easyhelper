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
  const zoomRealBtn = $('zoomReal');
  const zoomLabel = $('zoomLabel');
  const liveBanner = $('liveBanner');
  const liveBannerText = $('liveBannerText');
  const badgeHttps = $('badgeHttps');
  const badgeE2ee = $('badgeE2ee');
  const badgeConn = $('badgeConn');
  const sysInfo = $('sysInfo');
  const logPanel = $('logPanel');
  const logRows = $('logRows');
  const logEmpty = $('logEmpty');

  // Bandeau d'état : transport (HTTPS), chiffrement de bout en bout des images
  // et état de la connexion — la vérité de ce qui se passe, affichée.
  function setBadge(el, cls, text) {
    if (!el) return;
    el.textContent = text;
    el.className = 'badge ' + cls;
  }

  function initBadges() {
    setBadge(badgeHttps, location.protocol === 'https:' ? 'ok' : 'warn',
      location.protocol === 'https:' ? '🔒 HTTPS' : '⚠ HTTP (non chiffré)');
    setBadge(badgeE2ee, 'off', 'Chiffrement…');
    setBadge(badgeConn, 'off', 'Hors session');
  }
  const viewerStatus = $('viewerStatus');
  const closeBtn = $('closeBtn');
  const terminateBtn = $('terminateBtn');
  const logoutBtn = $('logoutBtn');

  let controller = null;
  let objectUrl = null;
  let endMsg = null;
  let encryptedSession = false;
  let currentCode = '';
  let terminating = false;

  // Zoom de la vue (100 % = ajusté à la largeur). L'image zoomée défile dans
  // le cadre : la page n'est jamais étirée.
  const ZOOM_MIN = 100;
  const ZOOM_MAX = 500;
  const ZOOM_STEP = 25;
  const ZOOM_FIT = 100;
  let zoom = ZOOM_FIT;

  // La bannière reflète l'état réel du partage. Sans cela elle continuait
  // d'annoncer « Écran en direct » après l'arrêt : seule la ligne de statut
  // changeait, sous l'image, et l'information principale restait fausse.
  function setLiveBanner(text, ended) {
    if (liveBannerText) liveBannerText.textContent = text;
    if (liveBanner) {
      if (ended) liveBanner.classList.add('ended');
      else liveBanner.classList.remove('ended');
    }
  }

  // Décodage minimal de l'agent utilisateur : système et navigateur — affichés
  // au technicien uniquement, rien n'est envoyé ailleurs.
  function parseUA(ua) {
    let os = 'Inconnu';
    let browser = 'Inconnu';
    if (/Windows NT 10\.0/.test(ua)) os = 'Windows 10/11';
    else if (/Windows NT [\d.]+/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    if (ua.indexOf('Edg/') >= 0) browser = 'Edge ' + ((ua.match(/Edg\/(\d+)/) || [])[1] || '?');
    else if (ua.indexOf('Chrome/') >= 0) browser = 'Chrome ' + ((ua.match(/Chrome\/(\d+)/) || [])[1] || '?');
    else if (ua.indexOf('Firefox/') >= 0) browser = 'Firefox ' + ((ua.match(/Firefox\/(\d+)/) || [])[1] || '?');
    else if (/Safari\//.test(ua)) browser = 'Safari';
    return { os, browser };
  }

  // Infos du poste de la personne aidée, reçues à la connexion. Tout est
  // affiché en textContent (aucune interprétation) : aucune injection possible.
  function renderSysInfo(diag) {
    if (!sysInfo || !diag) return;
    const ua = parseUA(String(diag.ua || ''));
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('diagOs', ua.os);
    set('diagBrowser', ua.browser);
    set('diagRam', (typeof diag.mem === 'number' && diag.mem > 0) ? '≈ ' + diag.mem + ' Go' : '—');
    set('diagCores', diag.cores ? String(diag.cores) : '—');
    set('diagScreen', diag.screen ? diag.screen + (diag.dpr && diag.dpr !== 1 ? ' · DPR ' + diag.dpr : '') : '—');
    set('diagLang', [diag.lang, diag.tz].filter(Boolean).join(' · ') || '—');
    set('diagNet', diag.net && diag.net.type
      ? [diag.net.type, typeof diag.net.downlink === 'number' ? diag.net.downlink + ' Mb/s' : '', typeof diag.net.rtt === 'number' ? diag.net.rtt + ' ms' : ''].filter(Boolean).join(' · ')
      : '—');
    set('diagSecure', diag.https === false ? 'HTTP (non sécurisé)' : 'HTTPS sécurisé');
    sysInfo.classList.remove('hidden');
  }

  async function refreshAuth() {
    let authed = false;
    try {
      const res = await fetch(API + '?action=me');
      const j = await res.json();
      authed = !!(j && j.ok);
    } catch { /* serveur injoignable */ }
    if (authed) { hide(loginCard); show(codeCard); loadAccessLog(); }
    else { show(loginCard); hide(codeCard); hide(viewer); if (logPanel) hide(logPanel); }
  }

  // ---------------------------------------------------------------------
  // Journal des connexions
  // ---------------------------------------------------------------------
  // Le code a été confié à un tiers : on garde une trace de qui a consulté
  // quelle session, pour pouvoir répondre à la question « qui s'est connecté,
  // et quand ». Trace volontairement non définitive, réservée au technicien
  // authentifié, et les adresses sont offusquées côté serveur (dernier octet
  // masqué) : le journal ne contient jamais une adresse complète.
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDate = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const fmtTime = (ms) => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); };

  async function loadAccessLog() {
    if (!logPanel || !logRows || typeof logRows.appendChild !== 'function') return;
    let entries = [];
    try {
      const res = await fetch(API + '?action=log');
      if (!res.ok) return;
      const j = await res.json();
      entries = (j && Array.isArray(j.entries)) ? j.entries : [];
    } catch { return; /* journal indisponible : ne bloque jamais l'assistance */ }
    logRows.textContent = '';
    for (const e of entries) {
      const tr = document.createElement('tr');
      // Tout passe par textContent : rien de ce qui vient du journal n'est
      // interprété comme du code.
      for (const v of [fmtDate(e.t), fmtTime(e.t), e.tech || '—', e.user || '—', e.code || '—']) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      }
      logRows.appendChild(tr);
    }
    if (logEmpty) { if (entries.length) hide(logEmpty); else show(logEmpty); }
    show(logPanel);
  }

  function closeViewer(backToCode = true) {
    if (controller) { controller.abort(); controller = null; }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    // Rien ne doit rester affiché après la fermeture de la vue.
    if (screenImg && screenImg.removeAttribute) screenImg.removeAttribute('src');
    endMsg = null;
    encryptedSession = false;
    currentCode = '';
    setZoom(ZOOM_FIT);
    initBadges();
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
    if (res.ok) { hide(loginCard); show(codeCard); loadAccessLog(); return; }
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
    if (info && info.diag) renderSysInfo(info.diag);
    setBadge(badgeE2ee, encryptedSession ? 'ok' : 'warn',
      encryptedSession ? '🔒 Chiffré de bout en bout' : '⚠ Relais direct (non chiffré)');
    openViewer(code);
  });

  function openViewer(code) {
    currentCode = code;
    if (terminateBtn) terminateBtn.disabled = false;
    controller = new AbortController();
    endMsg = null;
    setLiveBanner('Connexion…', false);
    setBadge(badgeConn, 'off', 'Connexion…');
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
              setLiveBanner('Écran en direct', false);
              setBadge(badgeE2ee, 'ok', '🔒 Chiffré de bout en bout');
              setBadge(badgeConn, 'ok', '● En direct');
              renderFrame(plain);
            } else {
              setStatus(viewerStatus, 'Connecté — écran en direct.');
              setLiveBanner('Écran en direct', false);
              setBadge(badgeE2ee, 'warn', '⚠ Relais direct (non chiffré)');
              setBadge(badgeConn, 'ok', '● En direct');
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
      : reason === 'tech-stopped'
        ? 'Vous avez mis fin à la session. Plus aucune image n\u2019est acceptée.'
        : reason === 'client-gone'
          ? 'La personne aidée ne répond plus : session terminée.'
          : 'Session terminée (' + reason + ').';
    setStatus(viewerStatus, endMsg);
    setLiveBanner('Partage terminé', true);
    setBadge(badgeConn, 'off', 'Terminé');
    // L'image est effacée : après la fin du partage, il ne doit rien rester à
    // l'écran — ni sur le serveur (purgé), ni dans le navigateur du technicien.
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    if (screenImg && screenImg.removeAttribute) screenImg.removeAttribute('src');
    if (terminateBtn) terminateBtn.disabled = true;
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

  // Un appui doit toujours produire un changement, même si le navigateur
  // n'émet pas d'événement 'click' fiable sur ces boutons compacts (tactile,
  // pavé tactile). On écoute donc aussi 'pointerdown', en dédupliquant le
  // geste : un même appui déclenche 'pointerdown' PUIS 'click', ce qui
  // compterait double. Les clics rapides restent tous pris en compte.
  function onZoomButton(btn, fn) {
    let handledByPointer = false;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handledByPointer = true;
      fn();
    });
    btn.addEventListener('click', () => {
      if (handledByPointer) { handledByPointer = false; return; }
      fn();
    });
  }

  onZoomButton(zoomInBtn, () => setZoom(zoom + ZOOM_STEP));
  onZoomButton(zoomOutBtn, () => setZoom(zoom - ZOOM_STEP));
  zoomFitBtn.addEventListener('click', () => { setZoom(ZOOM_FIT); screenBox.scrollTo(0, 0); });
  // « 1:1 » : chaque pixel de l'écran aidé sur un pixel de l'écran du
  // technicien — c'est la seule façon de lire un texte fin sans l'agrandir
  // puis le deviner. Le pourcentage reste exprimé par rapport à la largeur du
  // cadre, comme le zoom manuel.
  if (zoomRealBtn) zoomRealBtn.addEventListener('click', () => {
    const nat = screenImg.naturalWidth || 0;
    const cw = screenBox.clientWidth || 0;
    if (!nat || !cw) return;
    setZoom(Math.round(nat / cw * 100));
    screenBox.scrollTo(0, 0);
  });

  // Arrêt net décidé par le technicien : la personne aidée peut avoir laissé
  // son partage tourner (fenêtre oubliée). Le serveur refuse alors toute image
  // et efface celle qu'il détenait — on passe à la personne suivante le
  // esprit tranquille.
  async function terminateSession() {
    if (!currentCode || terminating) return;
    terminating = true;
    if (terminateBtn) terminateBtn.disabled = true;
    try {
      await fetch(API + '?action=end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: currentCode }),
      });
    } catch { /* l'état local est mis à jour même si le serveur n'a pas répondu */ }
    terminating = false;
    endedMsg('tech-stopped');
  }

  if (terminateBtn) terminateBtn.addEventListener('click', terminateSession);

  closeBtn.addEventListener('click', () => closeViewer());
  logoutBtn.addEventListener('click', async () => {
    try { await fetch(API + '?action=logout', { method: 'POST' }); } catch { /* ignore */ }
    closeViewer();
    refreshAuth();
  });

  // Lien direct possible : tech.html#code=123456
  const m = location.hash.match(/code=(\d{6})/);
  if (m) codeInput.value = m[1];

  initBadges();
  applyZoom();
  refreshAuth();
})();
