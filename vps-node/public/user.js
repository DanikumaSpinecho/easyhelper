// Page « personne aidée » : partage d'écran en lecture seule (variante Node.js).
// Les images sont chiffrées de bout en bout (ECDH P-256 + AES-256-GCM) avant
// d'être envoyées sur le canal WebSocket : le relais ne voit que des octets
// illisibles. Aucune interaction supplémentaire n'est demandée.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');
  const cryptoApi = window.EHCrypto || { available: false };

  const startBtn = $('startBtn');
  const stopBtn = $('stopBtn');
  const intro = $('intro');
  const sharing = $('sharing');
  const codeEl = $('code');
  const peerNote = $('peerNote');
  const statusEl = $('status');

  // 1er octet de chaque image : 1 = chiffrée, 0 = en clair (repli).
  const FLAG_ENCRYPTED = 1;
  const FLAG_PLAIN = 0;

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
  // 'wait' : en attente de la clé du technicien ; 'encrypted' : images chiffrées ;
  // 'plain' : envoi direct (navigateur ou technicien sans chiffrement).
  let mode = 'wait';
  let lastTechPub = '';

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
      msg = 'Cette page doit être ouverte en HTTPS (' + location.origin + ').\nVotre navigateur bloque le partage d\u2019écran sur une connexion non sécurisée.';
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
    mode = 'wait';
    lastTechPub = '';
    peerNote.textContent = '';
    document.title = 'Aide à distance · ' + location.host;
    hide(sharing);
    show(intro);
  }

  async function startSharing() {
    setStatus('');
    stopping = false;
    mode = 'wait';
    lastTechPub = '';
    quality = 0.6;

    // 1. Autorisation de capture d'abord (exige un geste utilisateur).
    let ds;
    try {
      // Choix réduit à l'écran : « displaySurface: 'monitor' » supprime les
      // options « onglet » et « fenêtre » de la boîte de dialogue sur Chrome —
      // la personne aidée n'a plus qu'à valider l'écran proposé. Valeur simple
      // (sémantique « ideal », pas « exact ») : un navigateur qui ne connaît
      // pas ces contraintes les ignore au lieu de faire échouer le partage.
      ds = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 3, max: 5 },
          displaySurface: 'monitor',
          surfaceSwitching: 'exclude',
          selfBrowserSurface: 'exclude',
        },
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
    // Sans API de chiffrement dans ce navigateur, on envoie directement.
    if (!cryptoApi.available) mode = 'plain';

    // 3. Connexion au relais (WSS, port 443 derrière le reverse proxy).
    const myPub = cryptoApi.available ? await cryptoApi.pubkey() : '';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws/user');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      // Jeton + clé publique éphémère : rien ne circule dans l'URL ni les journaux.
      ws.send(JSON.stringify({ type: 'auth', token: sessionInfo.token, userPub: myPub }));
      beginCapture();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'tech-joined' || msg.type === 'tech-present') {
        syncTechKey(msg.techPub || '', msg.techCrypto !== false);
      } else if (msg.type === 'tech-left') {
        peerNote.textContent = 'Votre proche s\u2019est déconnecté (le partage continue).';
      } else if (msg.type === 'session-ended') {
        endLocal('La session a été terminée (' + (msg.reason || 'serveur') + ').');
      }
    };
    ws.onclose = () => {
      if (stopping) return;
      stopping = true;
      resetUi();
      setStatus('Partage terminé (session expirée ou connexion interrompue).');
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  // Négocie la clé dès que la clé publique du technicien est disponible.
  // Une nouvelle clé (page rechargée côté technicien) déclenche une nouvelle
  // dérivation. Si le technicien ne peut pas chiffrer, on bascule en direct
  // plutôt que de laisser la personne aidée sans assistance.
  async function syncTechKey(techPub, techCrypto) {
    if (!techPub) {
      if (techCrypto === false && mode === 'wait') mode = 'plain';
      return;
    }
    if (techPub === lastTechPub && mode !== 'wait') return; // déjà négocié avec cette clé
    if (!cryptoApi.available) { mode = 'plain'; return; }
    const key = await cryptoApi.derive(techPub, sessionInfo ? (sessionInfo.salt || '') : '');
    if (key) {
      lastTechPub = techPub;
      mode = 'encrypted';
      peerNote.textContent = '✅ Votre proche est connecté et voit votre écran.';
    } else if (mode === 'wait') {
      mode = 'plain';
    }
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
    peerNote.textContent = 'En attente du technicien…';
    // Les images ne partent qu'une fois le technicien connecté (et la clé
    // négociée) : rien n'est transmis avant.
    timer = setInterval(captureFrame, 300);
  }

  function frameWithFlag(flag, bytes) {
    const out = new Uint8Array(bytes.length + 1);
    out[0] = flag;
    out.set(bytes, 1);
    return out;
  }

  async function captureFrame() {
    if (capturing || stopping) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!video || !video.videoWidth) return;
    if (mode === 'wait') return;   // on attend la clé du technicien
    capturing = true;

    const scale = Math.min(1, 1280 / video.videoWidth);
    const w = Math.max(2, Math.round(video.videoWidth * scale));
    const h = Math.max(2, Math.round(video.videoHeight * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    try {
      ctx.drawImage(video, 0, 0, w, h);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) { capturing = false; return; }

      // Qualité adaptative : on reste sous ~230 Ko, marge de chiffrement comprise.
      if (blob.size > 225 * 1024) quality = Math.max(0.3, quality - 0.1);
      else if (blob.size < 60 * 1024 && quality < 0.75) quality = Math.min(0.75, quality + 0.05);

      const buf = new Uint8Array(await blob.arrayBuffer());
      let frame;
      if (mode === 'encrypted') {
        const enc = await cryptoApi.encryptFrame(buf);
        if (enc) {
          frame = frameWithFlag(FLAG_ENCRYPTED, enc);
        } else {
          mode = 'plain';
          frame = frameWithFlag(FLAG_PLAIN, buf);
        }
      } else {
        frame = frameWithFlag(FLAG_PLAIN, buf);
      }
      capturing = false;
      if (ws && ws.readyState === WebSocket.OPEN && !stopping) ws.send(frame);
    } catch {
      capturing = false;
    }
  }

  function endLocal(msg) {
    if (stopping) return;
    stopping = true;
    resetUi();
    setStatus(msg);
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
