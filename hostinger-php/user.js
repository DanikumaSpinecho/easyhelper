// Page « personne aidée » : partage d'écran en lecture seule (version hébergement mutualisé).
// Les images sont envoyées par POST HTTPS (api.php?action=upload), ~2,5 par seconde.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');
  const API = 'api.php';

  const startBtn = $('startBtn');
  const stopBtn = $('stopBtn');
  const intro = $('intro');
  const sharing = $('sharing');
  const codeEl = $('code');
  const peerNote = $('peerNote');
  const statusEl = $('status');

  let stream = null;
  let video = null;
  let canvas = null;
  let ctx = null;
  let sessionInfo = null;
  let quality = 0.6;
  let capturing = false;
  let stopping = false;
  let failCount = 0;
  let intervalMs = 400;
  let timer = null;

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
    if (timer) { clearTimeout(timer); timer = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
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
    failCount = 0;
    intervalMs = 400;

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
      res = await fetch(API + '?action=create', { method: 'POST' });
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

    // 3. Capture hors écran.
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
    scheduleTick();
  }

  function scheduleTick() {
    timer = setTimeout(tick, intervalMs);
  }

  async function tick() {
    scheduleTick();
    if (stopping || !sessionInfo) return;
    if (!video || !video.videoWidth || capturing) return;
    capturing = true;

    const scale = Math.min(1, 1280 / video.videoWidth);
    const w = Math.max(2, Math.round(video.videoWidth * scale));
    const h = Math.max(2, Math.round(video.videoHeight * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    let blob = null;
    try {
      ctx.drawImage(video, 0, 0, w, h);
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    } catch {
      blob = null;
    }
    if (!blob) { capturing = false; return; }

    // Qualité adaptative : on reste sous ~190 Ko pour la limite serveur (200 Ko).
    if (blob.size > 190 * 1024) quality = Math.max(0.3, quality - 0.1);
    else if (blob.size < 60 * 1024 && quality < 0.75) quality = Math.min(0.75, quality + 0.05);

    const buf = await blob.arrayBuffer().catch(() => null);
    capturing = false;
    if (!buf || stopping || !sessionInfo) return;

    try {
      const res = await fetch(API + '?action=upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Code': sessionInfo.code,
          'X-Token': sessionInfo.token,
        },
        body: buf,
      });
      if (res.status === 429) { intervalMs = Math.min(2000, intervalMs + 400); return; }
      if (res.status === 401) { endLocal('Session rejetée par le serveur.'); return; }
      intervalMs = Math.max(400, intervalMs - 100);
      const j = await res.json().catch(() => null);
      if (j && j.state === 'ended') {
        endLocal('La session a été terminée (' + (j.reason || 'serveur') + ').');
        return;
      }
      peerNote.textContent = j && j.tech_present
        ? '✅ Votre proche est connecté et voit votre écran.'
        : '';
      failCount = 0;
    } catch {
      failCount++;
      if (failCount >= 4) endLocal('Connexion au serveur perdue. Le partage s\u2019est arrêté.');
    }
  }

  function endLocal(msg) {
    if (stopping) return;
    stopping = true;
    resetUi();
    setStatus(msg);
  }

  async function stopSharing() {
    if (stopping) return;
    stopping = true;
    if (sessionInfo) {
      try {
        await fetch(API + '?action=stop', {
          method: 'POST',
          headers: { 'X-Code': sessionInfo.code, 'X-Token': sessionInfo.token },
        });
      } catch { /* ignore */ }
    }
    resetUi();
    setStatus('Partage terminé. Rien n\u2019a été enregistré.');
  }

  startBtn.addEventListener('click', startSharing);
  stopBtn.addEventListener('click', stopSharing);
  checkCapability();
})();
