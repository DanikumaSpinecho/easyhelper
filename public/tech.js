// Page technicien : authentification, saisie du code, visionneuse en lecture seule.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');
  const setStatus = (el, text) => { el.textContent = text; if (text) show(el); else hide(el); };

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
    let res;
    try {
      res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    } catch {
      setStatus(joinStatus, 'Impossible de contacter le serveur.');
      return;
    }
    if (res.status === 404) { setStatus(joinStatus, 'Code inconnu ou session déjà terminée.'); return; }
    if (!res.ok) { setStatus(joinStatus, 'Erreur (' + res.status + '). Réessayez.'); return; }
    openViewer(code);
  });

  function openViewer(code) {
    closeViewer(false);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws/tech?code=' + encodeURIComponent(code));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      hide(codeCard);
      show(viewer);
      setStatus(viewerStatus, 'Connecté — écran en direct.');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'session-ended') {
          endMsg = msg.reason === 'user-stopped'
            ? 'La personne aidée a arrêté le partage.'
            : 'Session terminée (' + msg.reason + ').';
          setStatus(viewerStatus, endMsg);
        }
        return;
      }
      renderFrame(ev.data);
    };
    ws.onclose = () => {
      ws = null;
      if (endMsg) return; // la vue reste affichée avec le message de fin
      closeViewer();
      setStatus(joinStatus, 'Connexion fermée.');
    };
    ws.onerror = () => { try { if (ws) ws.close(); } catch { /* ignore */ } };
  }

  function renderFrame(buf) {
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
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
