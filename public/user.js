// Page « personne aidée » : partage d'écran en lecture seule.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');

  const startBtn = $('startBtn');
  const stopBtn = $('stopBtn');
  const intro = $('intro');
  const sharing = $('sharing');
  const codeEl = $('code');
  const peerNote = $('peerNote');
  const statusEl = $('status');

  let ws = null;
  let stream = null;
  let timer = null;
  let quality = 0.6;
  let capturing = false;
  let stopping = false;
  let sessionInfo = null;
  let video = null;
  let canvas = null;
  let ctx = null;

  function setStatus(text) {
    statusEl.textContent = text;
    if (text) show(statusEl); else hide(statusEl);
  }

  function isSupported() {
    return window.isSecureContext &&
      typeof navigator.mediaDevices !== 'undefined' &&
      typeof navigator.mediaDevices.getDisplayMedia === 'function';
  }

  function checkCapability() {
    if (isSupported()) return;
    hide(intro);
    show($('unsupported'));
    let msg;
    if (!window.isSecureContext) {
      msg = 'Cette page doit être ouverte en HTTPS (https://support.spinecho.fr).\nVotre navigateur bloque le partage d\u2019écran sur une connexion non sécurisée.';
    } else {
      msg = 'Votre navigateur ne permet pas le partage d\u2019écran sur cet appareil.\n\n'
        + '• Ordinateur : utilisez Chrome, Edge, Firefox ou Safari (macOS).\n'
        + '• Téléphone ou tablette : le partage d\u2019écran depuis un navigateur mobile n\u2019est pas possible (Android comme iPhone/iPad).\n\n'
        + 'Pour être aidé : ouvrez cette page sur un ordinateur.\nPour aider : la page technicien fonctionne aussi sur mobile.';
    }
    $('unsupportedMsg').textContent = msg;
  }

  function resetUi() {
    if (timer) { clearInterval(timer); timer = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
    video = null;
    canvas = null;
    ctx = null;
    sessionInfo = null;
    peerNote.textContent = '';
    document.title = 'Aide à distance · support.spinecho.fr';
    hide(sharing);
    show(intro);
  }

  async function startSharing() {
    setStatus('');
    stopping = false;

    // 1. Autorisation de capture d'abord (exige un geste utilisateur).
    let ds;
    try {
      ds = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 3, max: 5 } },
        audio: false,
      });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') setStatus('Partage annulé : vous avez refusé l\u2019autorisation.');
      else if (err && err.name === 'NotFoundError') setStatus('Aucun écran sélectionné.');
      else setStatus('Impossible de démarrer la capture (' + (err && err.name ? err.name : 'erreur inconnue') + ').');
      return;
    }

    stream = ds;
    const track = stream.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => {
      if (stopping) return;
      stopping = true;
      resetUi();
      setStatus('Le partage a été arrêté depuis le navigateur.');
    });

    // 2. Création de la session relais.
    let res;
    try {
      res = await fetch('/api/session', { method: 'POST' });
    } catch {
      resetUi();
      setStatus('Impossible de contacter le serveur.');
      return;
    }
    let sess = null;
    try { sess = await res.json(); } catch { /* ignore */ }
    if (!res.ok || !sess || !sess.token) {
      resetUi();
      if (res.status === 429) setStatus('Service momentanément saturé. Réessayez dans quelques minutes.');
      else setStatus('Impossible de créer la session.');
      return;
    }
    sessionInfo = sess;

    // 3. Connexion au relais (WSS, port 443 derrière le reverse proxy).
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws/user');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      // Le jeton est envoyé en premier message (jamais dans l'URL ni les journaux).
      ws.send(JSON.stringify({ type: 'auth', token: sessionInfo.token }));
      beginCapture();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'tech-joined') peerNote.textContent = '✅ Votre proche est connecté et voit votre écran.';
      else if (msg.type === 'tech-left') peerNote.textContent = 'Votre proche s\u2019est déconnecté (le partage continue).';
    };
    ws.onclose = () => {
      if (stopping) return;
      stopping = true;
      resetUi();
      setStatus('Partage terminé (session expirée ou connexion interrompue).');
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  function beginCapture() {
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    video.play().catch(() => { /* autoplay muted : accepté par les navigateurs modernes */ });
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
    document.title = '🔴 Partage en cours';
    codeEl.textContent = sessionInfo.code;
    hide(intro);
    show(sharing);
    timer = setInterval(captureFrame, 300);
  }

  function captureFrame() {
    if (capturing || stopping) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!video || !video.videoWidth) return;
    capturing = true;
    const scale = Math.min(1, 1280 / video.videoWidth);
    const w = Math.max(2, Math.round(video.videoWidth * scale));
    const h = Math.max(2, Math.round(video.videoHeight * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    try {
      ctx.drawImage(video, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (!blob) { capturing = false; return; }
        // Qualité adaptative : on reste sous ~230 Ko/image pour la limite serveur.
        if (blob.size > 230 * 1024) quality = Math.max(0.3, quality - 0.1);
        else if (blob.size < 60 * 1024 && quality < 0.75) quality = Math.min(0.75, quality + 0.05);
        blob.arrayBuffer()
          .then((buf) => {
            capturing = false;
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
          })
          .catch(() => { capturing = false; });
      }, 'image/jpeg', quality);
    } catch {
      capturing = false;
    }
  }

  function stopSharing() {
    if (stopping) return;
    stopping = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* ignore */ }
    }
    resetUi();
    setStatus('Partage terminé. Rien n\u2019a été enregistré.');
  }

  startBtn.addEventListener('click', startSharing);
  stopBtn.addEventListener('click', stopSharing);
  checkCapability();
})();
