// Page technicien : authentification, saisie du code, visionneuse en lecture seule
// (variante Node.js). Les images reçues sont déchiffrées dans ce navigateur
// (ECDH P-256 + AES-256-GCM) : le relais ne les a jamais vues en clair.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');
  const setStatus = (el, text) => { el.textContent = text; if (text) show(el); else hide(el); };
  const cryptoApi = window.EHCrypto || { available: false };

  const FLAG_ENCRYPTED = 1;

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

  let ws = null;
  let objectUrl = null;
  let endMsg = null;
  let salt = '';

  async function refreshAuth() {
    let authed = false;
    try {
      authed = (await fetch('/api/me')).ok;
    } catch { /* serveur injoignable */ }
    if (authed) { hide(loginCard); show(codeCard); }
    else { show(loginCard); hide(codeCard); hide(viewer); }
  }

  function closeViewer(backToCode = true) {
    if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
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
      res = await fetch('/api/login', {
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
    else if (res.status === 503) setStatus(loginStatus, 'Service non configuré (mot de passe technicien absent).');
    else setStatus(loginStatus, 'Mot de passe incorrect.');
  });

  codeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus(joinStatus, '');
    const code = codeInput.value.replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) { setStatus(joinStatus, 'Le code comporte 6 chiffres.'); return; }

    // Notre clé publique éphémère accompagne la vérification du code : elle sera
    // transmise à la personne aidée, qui chiffrera pour nous seul.
    const techPub = cryptoApi.available ? await cryptoApi.pubkey() : '';
    let res;
    try {
      res = await fetch('/api/join', {
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
    if (info && info.salt) salt = info.salt;
    if (info && info.crypto === 'ecdh-p256-aesgcm' && info.userPub && cryptoApi.available) {
      // La personne aidée était déjà connectée : on dérive la clé sans attendre.
      await cryptoApi.derive(info.userPub, salt);
    }
    openViewer(code);
  });

  function openViewer(code) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws/tech?code=' + encodeURIComponent(code));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      hide(codeCard);
      show(viewer);
      setStatus(viewerStatus, 'Connecté — écran en direct.');
    };
    ws.onmessage = async (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'joined') {
          // Sel et clé publique de la personne aidée : de quoi déchiffrer.
          if (msg.salt) salt = msg.salt;
          if (msg.userPub && cryptoApi.available) await cryptoApi.derive(msg.userPub, salt);
        } else if (msg.type === 'user-pub') {
          // La personne aidée vient de s'authentifier (clé publiée après coup).
          if (msg.salt) salt = msg.salt;
          if (msg.userPub && cryptoApi.available) await cryptoApi.derive(msg.userPub, salt);
        } else if (msg.type === 'session-ended') {
          endMsg = msg.reason === 'user-stopped'
            ? 'La personne aidée a arrêté le partage.'
            : 'Session terminée (' + msg.reason + ').';
          setStatus(viewerStatus, endMsg);
        }
        return;
      }
      const bytes = new Uint8Array(ev.data);
      if (bytes.length < 2) return;
      const flag = bytes[0];
      const payload = bytes.subarray(1);
      if (flag === FLAG_ENCRYPTED) {
        if (!cryptoApi.available || typeof cryptoApi.decryptFrame !== 'function') {
          setStatus(viewerStatus, 'Image protégée : ce navigateur ne prend pas en charge le déchiffrement.');
          return;
        }
        const plain = await cryptoApi.decryptFrame(payload);
        if (!plain) {
          setStatus(viewerStatus, 'Image protégée — déchiffrement impossible (clé non négociée).');
          return;
        }
        setStatus(viewerStatus, 'Connecté — écran en direct (chiffré de bout en bout).');
        renderFrame(plain);
      } else {
        setStatus(viewerStatus, 'Connecté — écran en direct.');
        renderFrame(payload);
      }
    };
    ws.onclose = () => {
      ws = null;
      if (endMsg) return; // la vue reste affichée avec le message de fin
      closeViewer();
      setStatus(joinStatus, 'Connexion fermée.');
    };
    ws.onerror = () => { try { if (ws) ws.close(); } catch { /* ignore */ } };
  }

  function renderFrame(bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    screenImg.src = url;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = url;
  }

  closeBtn.addEventListener('click', () => closeViewer());
  logoutBtn.addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    closeViewer();
    refreshAuth();
  });

  // Lien direct possible : tech.html#code=123456
  const m = location.hash.match(/code=(\d{6})/);
  if (m) codeInput.value = m[1];

  refreshAuth();
})();
