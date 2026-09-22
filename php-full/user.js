// Page « personne aidée » : partage d'écran en lecture seule (version hébergement mutualisé).
// Les images sont chiffrées de bout en bout (ECDH P-256 + AES-256-GCM) avant
// l'envoi par POST HTTPS : le serveur ne relaie que des octets illisibles pour
// lui. Aucune interaction supplémentaire n'est demandée à la personne aidée.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');
  const API = 'api.php';
  const cryptoApi = window.EHCrypto;

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
  let statusTimer = null;
  // 'wait' : en attente de la clé du technicien ; 'encrypted' : images chiffrées ;
  // 'plain' : envoi direct (navigateur ou technicien sans chiffrement).
  let mode = 'wait';
  let lastTechPub = '';

  function setStatus(text) {
    statusEl.textContent = text;
    if (text) show(statusEl); else hide(statusEl);
  }

  // Motif de fin exprimé en clair : la personne aidée doit comprendre pourquoi
  // le partage s'est arrêté, sans jargon (elle n'a rien demandé).
  function reasonLabel(reason) {
    switch (reason) {
      case 'user-stopped': return 'Vous avez arrêté le partage.';
      case 'tech-stopped': return 'Le technicien a mis fin à la session.';
      case 'client-gone': return 'Session expirée : la fenêtre de partage avait été fermée.';
      case 'idle-timeout': return 'Session expirée après une longue inactivité.';
      case 'max-duration': return 'Durée maximale de la session atteinte.';
      default: return 'Session terminée (' + (reason || 'serveur') + ').';
    }
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
    if (timer) { clearTimeout(timer); timer = null; }
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
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
    failCount = 0;
    intervalMs = 400;
    mode = 'wait';
    lastTechPub = '';

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
      // « Arrêter le partage » de Chrome ferme la piste sans prévenir le
      // serveur : la session restait « en direct » et l'image restait stockée.
      notifyStop();
      resetUi();
      setStatus('Le partage a été arrêté depuis le navigateur.');
    });

    // 2. Création de la session relais, avec notre clé publique éphémère.
    const myPub = cryptoApi && cryptoApi.available ? await cryptoApi.pubkey() : '';
    let res;
    try {
      res = await fetch(API + '?action=create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPub: myPub, diag: collectDiag() }),
      });
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
    if (!cryptoApi || !cryptoApi.available || !myPub) mode = 'plain';

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
    peerNote.textContent = 'En attente du technicien…';
    // Les images ne partent qu'une fois le technicien connecté : rien n'est
    // transmis avant, et la clé de chiffrement est alors négociée.
    scheduleTick();
    pollStatus();
  }

  // Attend la clé publique du technicien (et surveille la fin de session).
  async function pollStatus() {
    if (stopping || !sessionInfo) return;
    const delay = mode === 'encrypted' ? 4000 : 1000;
    statusTimer = setTimeout(pollStatus, delay);
    if (!sessionInfo || stopping) return;
    try {
      const res = await fetch(API + '?action=status', {
        headers: { 'X-Code': sessionInfo.code, 'X-Token': sessionInfo.token },
      });
      if (res.status === 401) { endLocal('Session rejetée par le serveur.'); return; }
      const j = await res.json().catch(() => null);
      if (!j) return;
      if (j.state === 'ended') {
        endLocal(reasonLabel(j.reason));
        return;
      }
      await syncTechKey(j.tech_pub || '', !!j.tech_joined, j.tech_crypto === true);
      if (!j.tech_present) peerNote.textContent = 'En attente du technicien…';
      else if (mode === 'wait') peerNote.textContent = 'Le technicien est connecté…';
    } catch { /* réessai au prochain cycle */ }
  }

  // Négocie la clé dès que la clé publique du technicien est disponible.
  // Si le technicien est connecté sans pouvoir chiffrer, on bascule en direct
  // plutôt que de laisser la personne aidée sans assistance.
  async function syncTechKey(techPub, techJoined, techCrypto) {
    if (mode !== 'wait') return;
    if (!techPub) {
      // Connecté mais aucune clé publiée : repli explicite en envoi direct.
      if (techJoined && !techCrypto) mode = 'plain';
      return;
    }
    if (!cryptoApi || !cryptoApi.available || !sessionInfo) { mode = 'plain'; return; }
    const key = await cryptoApi.derive(techPub, sessionInfo.salt || '');
    if (key) {
      lastTechPub = techPub;
      mode = 'encrypted';
      peerNote.textContent = '✅ Votre proche est connecté et voit votre écran.';
    } else {
      mode = 'plain';
    }
  }

  function scheduleTick() {
    timer = setTimeout(tick, intervalMs);
  }

  async function tick() {
    scheduleTick();
    if (stopping || !sessionInfo) return;
    if (!video || !video.videoWidth || capturing) return;
    if (mode === 'wait') return;   // on attend la clé du technicien
    capturing = true;

    // Résolution native de l'écran (plafonnée à 1920) : réduire à 1280 px
    // rendait le texte illisible — zoomer ensuite n'agrandissait que des pixels
    // qui n'avaient jamais été transmis. Le budget de taille est tenu par la
    // qualité adaptative (juste en dessous), pas par la résolution.
    const scale = Math.min(1, 1920 / video.videoWidth);
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

    // On reste sous ~190 Ko, marge comprise pour l'en-tête de chiffrement (28 o).
    if (blob.size > 185 * 1024) quality = Math.max(0.3, quality - 0.1);
    else if (blob.size < 60 * 1024 && quality < 0.75) quality = Math.min(0.75, quality + 0.05);

    const raw = await blob.arrayBuffer().catch(() => null);
    capturing = false;
    if (!raw || stopping || !sessionInfo) return;

    // Chiffrement de bout en bout quand c'est possible ; sinon envoi direct.
    let payload;
    let contentType;
    if (mode === 'encrypted') {
      const enc = await cryptoApi.encryptFrame(raw);
      if (enc) {
        payload = enc;
        contentType = 'application/octet-stream';
      } else {
        payload = new Uint8Array(raw);
        contentType = 'image/jpeg';
        mode = 'plain';
      }
    } else {
      payload = new Uint8Array(raw);
      contentType = 'image/jpeg';
    }

    try {
      const res = await fetch(API + '?action=upload', {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'X-Code': sessionInfo.code,
          'X-Token': sessionInfo.token,
        },
        body: payload,
      });
      if (res.status === 429) { intervalMs = Math.min(2000, intervalMs + 400); return; }
      if (res.status === 401) { endLocal('Session rejetée par le serveur.'); return; }
      intervalMs = Math.max(400, intervalMs - 100);
      const j = await res.json().catch(() => null);
      if (j && j.state === 'ended') {
        endLocal(reasonLabel(j.reason));
        return;
      }
      if (j && j.tech_pub) await syncTechKey(j.tech_pub, !!j.tech_joined, j.tech_crypto === true);
      if (j && j.tech_present) peerNote.textContent = '✅ Votre proche est connecté et voit votre écran.';
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

  // Diagnostics du poste, exposés par le navigateur uniquement (rien
  // d'invasif) : envoyés UNE seule fois à la création, visibles seulement du
  // technicien, dans le canal déjà sécurisé. Rien n'est sondé en continu.
  function collectDiag() {
    const c = navigator.connection || {};
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
    return {
      ua: navigator.userAgent || '',
      platform: navigator.platform || '',
      cores: navigator.hardwareConcurrency || 0,
      mem: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null,
      screen: (typeof screen !== 'undefined' && screen.width) ? screen.width + 'x' + screen.height : '',
      dpr: window.devicePixelRatio || 1,
      lang: navigator.language || '',
      tz,
      net: (c.effectiveType || c.type) ? {
        type: c.effectiveType || c.type || '',
        downlink: typeof c.downlink === 'number' ? c.downlink : null,
        rtt: typeof c.rtt === 'number' ? c.rtt : null,
      } : null,
      https: location.protocol === 'https:',
    };
  }

  // Prévient le serveur que le partage s'arrête — y compris quand la fenêtre se
  // ferme. Sans cela, la session restait « en direct » et la dernière image
  // restait sur le serveur jusqu'à expiration : à éviter par respect de la vie
  // privée. sendBeacon est le seul envoi que le navigateur accepte de terminer
  // après la fermeture de la page (il ne permet pas d'en-têtes personnalisés,
  // d'où le jeton dans le corps JSON, accepté par le serveur).
  function notifyStop() {
    if (!sessionInfo) return;
    const code = sessionInfo.code;
    const token = sessionInfo.token;
    sessionInfo = null;
    const body = JSON.stringify({ code, token });
    try {
      if (navigator.sendBeacon
        && navigator.sendBeacon(API + '?action=stop', new Blob([body], { type: 'application/json' }))) return;
    } catch { /* repli ci-dessous */ }
    try {
      fetch(API + '?action=stop', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Code': code, 'X-Token': token },
        body,
      }).catch(() => {});
    } catch { /* filet de sécurité : le serveur termine seul la session */ }
  }

  async function stopSharing() {
    if (stopping) return;
    stopping = true;
    notifyStop();
    resetUi();
    setStatus('Partage terminé. Rien n\u2019a été enregistré.');
  }

  startBtn.addEventListener('click', startSharing);
  stopBtn.addEventListener('click', stopSharing);
  // Fermeture d'onglet ou de fenêtre : dernier moment où l'on peut encore agir.
  window.addEventListener('pagehide', () => { if (sessionInfo) notifyStop(); });
  checkCapability();
})();
