/**
 * easyhelper — relais de partage d'écran « vue seule »
 * -----------------------------------------------------------
 * La personne aidée partage son écran (getDisplayMedia + captures JPEG) ;
 * le technicien le regarde en direct. Aucune prise de contrôle possible,
 * aucun enregistrement : les images ne sont relayées qu'en mémoire.
 *
 * Démarrage :  node server.js
 * Config     :  config.json (créé automatiquement)
 * Mot de passe technicien :  npm run set-password -- <mot-de-passe>
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULTS = {
  host: '127.0.0.1',                 // écoute locale : le TLS est assuré par le reverse proxy
  port: 3080,
  cookieSecure: true,                // cookie technicien avec flag Secure (false uniquement en test HTTP)
  cookieTtlMs: 12 * 60 * 60 * 1000,  // durée de la session technicien : 12 h
  maxSessions: 20,                   // sessions de partage simultanées (total)
  maxSessionsPerIp: 3,               // sessions simultanées par IP (utilisateur)
  maxWsPerIp: 12,                    // connexions WebSocket simultanées par IP
  sessionIdleMs: 10 * 60 * 1000,     // fin si aucune image reçue pendant 10 min
  sessionMaxMs: 60 * 60 * 1000,      // durée maximale d'une session : 1 h
  maxFrameBytes: 256 * 1024,         // taille maximale d'une image relayée (au-delà : session coupée)
  minFrameIntervalMs: 200,           // 5 images/s max relayées
  maxBytesPerSec: 768 * 1024,        // débit max par session (fenêtre glissante 10 s)
  loginMaxAttempts: 10,              // tentatives de connexion technicien par IP…
  loginWindowMs: 15 * 60 * 1000,     // …par fenêtre glissante (15 min)
  createMaxPerMin: 6,                // créations de session max par minute et par IP
  joinMaxPerMin: 30,                 // vérifications de code max par minute et par IP
  maxAccessLog: 200,                 // entrées conservées dans le journal des connexions
};

let config = { ...DEFAULTS };
try {
  if (fs.existsSync(CONFIG_PATH)) {
    config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } else {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    console.log('[config] config.json créé. Définissez le mot de passe technicien :  npm run set-password -- <mot-de-passe>');
  }
} catch (err) {
  console.error('[config] Erreur de lecture/écriture de config.json :', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// État en mémoire uniquement (rien n'est écrit sur disque)
// ---------------------------------------------------------------------------

const sessions = new Map();      // code -> session
const authSessions = new Map();  // sid -> { expiresAt }
const ipState = new Map();       // ip -> { loginTimes, createTimes, joinTimes, wsCount }

function ipInfo(ip) {
  let st = ipState.get(ip);
  if (!st) {
    st = { loginTimes: [], createTimes: [], joinTimes: [], wsCount: 0 };
    ipState.set(ip, st);
  }
  return st;
}

// ---------------------------------------------------------------------------
// Journal des connexions (traçabilité)
// ---------------------------------------------------------------------------

const ACCESS_LOG = path.join(__dirname, 'data', 'access.jsonl');

/**
 * Offusque une adresse IP : la trace sert à distinguer des provenances, pas à
 * identifier une personne. On masque donc la fin de l'adresse (dernier octet en
 * IPv4, identité d'interface en IPv6) AVANT de l'écrire : le journal ne
 * contient jamais une adresse complète.
 */
function maskIp(ip) {
  if (!ip || ip === 'unknown') return 'inconnue';
  let v = String(ip);
  if (v.startsWith('::ffff:') && v.includes('.')) v = v.slice(7);   // IPv4 encapsulée en IPv6
  if (v.includes('.')) {
    const p = v.split('.');
    if (p.length !== 4) return 'inconnue';
    for (const o of p) {
      if (!/^\d{1,3}$/.test(o) || Number(o) > 255) return 'inconnue';
    }
    return `${Number(p[0])}.${Number(p[1])}.${Number(p[2])}.x`;
  }
  if (!v.includes(':')) return 'inconnue';
  // Développe la compression « :: » en 8 groupes — sans quoi 'fe80::1' donnerait
  // 'fe80:1', qui désigne une AUTRE adresse : le journal afficherait un préfixe
  // faux. inet_pton fait ce travail côté PHP ; ici on l'écrit explicitement.
  const parts = v.split('::');
  if (parts.length > 2) return 'inconnue';
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = (parts.length === 2 && parts[1]) ? parts[1].split(':') : [];
  const groupes = parts.length === 2
    ? head.concat(Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail)
    : head;
  if (groupes.length !== 8) return 'inconnue';
  const net = [];
  for (const g of groupes.slice(0, 4)) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return 'inconnue';
    net.push(g.replace(/^0+/, '') || '0');   // même forme que la variante PHP
  }
  return net.join(':') + ':x:x:x:x';
}

/**
 * Journalise l'accès d'un technicien à une session : date, heure et adresses IP
 * offusquées des deux côtés. Aucune adresse complète n'est écrite.
 *
 * Le journal est borné (config.maxAccessLog) et survit à la fin des sessions :
 * c'est précisément son objet. Il vit hors du dossier public, donc n'est jamais
 * servi par le web, et n'est lisible que par le technicien authentifié.
 */
function logAccess(techIp, userIp, code) {
  const entry = JSON.stringify({
    t: Date.now(),
    tech: maskIp(techIp),
    user: maskIp(userIp),
    code: /^\d{6}$/.test(String(code || '')) ? String(code) : '',
  });
  // Jamais d'échec pour l'assistance : une trace impossible à écrire passe.
  try {
    if (!fs.existsSync(path.dirname(ACCESS_LOG))) fs.mkdirSync(path.dirname(ACCESS_LOG), { recursive: true });
    fs.appendFileSync(ACCESS_LOG, entry + '\n', 'utf8');
    // Plafond : on élague en gardant les entrées les plus récentes.
    const lines = fs.readFileSync(ACCESS_LOG, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const max = Math.max(1, Number(config.maxAccessLog) || 200);
    if (lines.length > max) fs.writeFileSync(ACCESS_LOG, lines.slice(-max).join('\n') + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** Entrées les plus récentes d'abord, prêtes pour l'affichage. */
function readAccessLog(limit = 200) {
  try {
    if (!fs.existsSync(ACCESS_LOG)) return [];
    const lines = fs.readFileSync(ACCESS_LOG, 'utf8').split('\n').filter((l) => l.trim() !== '');
    return lines.slice(-Math.max(1, limit)).reverse()
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && typeof e.t === 'number');
  } catch { return []; }
}

function windowAllows(times, now, max, windowMs) {
  const cut = now - windowMs;
  while (times.length && times[0] < cut) times.shift();
  return times.length < max;
}

function createSession(ip) {
  let code;
  do { code = String(crypto.randomInt(100000, 1000000)); } while (sessions.has(code));
  const session = {
    code,
    userToken: crypto.randomBytes(32).toString('hex'),
    ip,
    createdAt: Date.now(),
    lastFrameAt: Date.now(),
    lastFrameTs: 0,
    byteWindow: { t: Date.now(), bytes: 0 },
    userWs: null,
    techWs: null,
    // Chiffrement de bout en bout : le serveur ne détient que des clés
    // PUBLIQUES et un sel ; la clé de session reste dans les navigateurs.
    salt: crypto.randomBytes(16).toString('hex'),
    userPub: '',
    techPub: '',
  };
  sessions.set(code, session);
  return session;
}

function endSession(session, reason) {
  if (!sessions.has(session.code)) return;
  const dur = Math.round((Date.now() - session.createdAt) / 1000);
  for (const ws of [session.userWs, session.techWs]) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'session-ended', reason }));
        ws.close(1001, 'session-ended');
      } catch { /* ignore */ }
    }
  }
  sessions.delete(session.code);
  // Journalisation minimale : code, horodatage, durée, motif — jamais d'image ni d'IP.
  console.log(`[session] code=${session.code} start=${new Date(session.createdAt).toISOString()} end=${new Date().toISOString()} dur=${dur}s reason=${reason}`);
}

// ---------------------------------------------------------------------------
// Authentification du technicien
// ---------------------------------------------------------------------------

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Valide une clé publique ECDH P-256 (point non compressé, 65 octets, préfixe 0x04).
 * Renvoie la clé en base64 standard, ou '' si elle est absente/invalide.
 */
function validPubkey(b64) {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length > 256) return '';
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 65 || raw[0] !== 0x04) return '';
  return raw.toString('base64');
}

/**
 * Prévient la personne aidée de l'arrivée du technicien, en lui transmettant
 * la clé publique de celui-ci : elle peut alors chiffrer à son intention seule.
 */
function notifyTechJoined(session) {
  if (!session.userWs || session.userWs.readyState !== WebSocket.OPEN) return;
  try {
    session.userWs.send(JSON.stringify({
      type: 'tech-joined',
      techPub: session.techPub,
      salt: session.salt,
      techCrypto: session.techPub !== '',
    }));
  } catch { /* ignore */ }
}

/**
 * Transmet au technicien la clé publique de la personne aidée dès qu'elle est
 * connue : sans cela, un technicien connecté en premier ne pourrait rien
 * déchiffrer (les deux arrivées sont possibles dans n'importe quel ordre).
 */
function notifyUserKey(session) {
  if (!session.techWs || session.techWs.readyState !== WebSocket.OPEN) return;
  try {
    session.techWs.send(JSON.stringify({
      type: 'user-pub',
      userPub: session.userPub,
      salt: session.salt,
      crypto: session.userPub ? 'ecdh-p256-aesgcm' : 'none',
    }));
  } catch { /* ignore */ }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isAuthed(req) {
  const sid = parseCookies(req).sid;
  const auth = authSessions.get(sid);
  if (!auth) return false;
  if (auth.expiresAt <= Date.now()) {
    authSessions.delete(sid);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Utilitaires HTTP
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req, limit = 4096) {
  return new Promise((resolve) => {
    let size = 0;
    let done = false;
    const chunks = [];
    const finish = (obj) => { if (!done) { done = true; resolve(obj); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { finish(null); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { finish(null); }
    });
    req.on('error', () => finish(null));
  });
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return false;
  let isFile = false;
  try { isFile = fs.statSync(filePath).isFile(); } catch { /* ignore */ }
  if (!isFile) return false;
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    ...SECURITY_HEADERS,
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// ---------------------------------------------------------------------------
// API HTTP
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || 'unknown';

  // POST /api/login — authentification du technicien
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const st = ipInfo(ip);
    const now = Date.now();
    if (!windowAllows(st.loginTimes, now, config.loginMaxAttempts, config.loginWindowMs)) {
      return sendJson(res, 429, { error: 'rate-limited' });
    }
    const body = await readJson(req);
    st.loginTimes.push(now);
    if (!config.techPasswordHash) return sendJson(res, 503, { error: 'not-configured' });
    const password = body && typeof body.password === 'string' ? body.password : '';
    if (!verifyPassword(password, config.techPasswordHash)) {
      return sendJson(res, 401, { error: 'bad-credentials' });
    }
    const sid = crypto.randomBytes(32).toString('hex');
    authSessions.set(sid, { expiresAt: now + config.cookieTtlMs });
    const parts = [`sid=${sid}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${Math.floor(config.cookieTtlMs / 1000)}`];
    if (config.cookieSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/logout
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const sid = parseCookies(req).sid;
    if (sid) authSessions.delete(sid);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/log — journal des connexions (technicien authentifié). C'est une
  // trace d'audit : elle n'a rien à faire dans une page publique.
  if (req.method === 'GET' && url.pathname === '/api/log') {
    if (!isAuthed(req)) return sendJson(res, 401, { error: 'auth-required' });
    return sendJson(res, 200, { entries: readAccessLog(config.maxAccessLog), masked: true });
  }

  // GET /api/me — l'interface technicien s'en sert pour afficher le bon écran
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const authed = isAuthed(req);
    return sendJson(res, authed ? 200 : 401, { ok: authed });
  }

  // POST /api/session — création d'une session de partage (personne aidée)
  if (req.method === 'POST' && url.pathname === '/api/session') {
    const st = ipInfo(ip);
    const now = Date.now();
    if (!windowAllows(st.createTimes, now, config.createMaxPerMin, 60 * 1000)) {
      return sendJson(res, 429, { error: 'rate-limited' });
    }
    st.createTimes.push(now);
    const activeForIp = [...sessions.values()].filter((s) => s.ip === ip).length;
    if (activeForIp >= config.maxSessionsPerIp) return sendJson(res, 429, { error: 'too-many-sessions' });
    if (sessions.size >= config.maxSessions) return sendJson(res, 429, { error: 'busy' });
    const session = createSession(ip);
    // Diagnostics du poste de la personne aidée (exposés par le navigateur) :
    // stockés en mémoire, bornés en taille, restitués au seul technicien.
    const body = await readJson(req);
    if (body && body.diag && typeof body.diag === 'object' && !Array.isArray(body.diag)) {
      try {
        const enc = JSON.stringify(body.diag);
        if (enc.length <= 2000) session.diag = body.diag;
      } catch { /* ignore */ }
    }
    return sendJson(res, 200, {
      code: session.code,
      token: session.userToken,
      // Chiffrement de bout en bout : la clé publique de la personne aidée et
      // celle du technicien seront échangées via le relais, qui ne peut pas en
      // déduire la clé de session.
      crypto: 'ecdh-p256-aesgcm',
      salt: session.salt,
      sessionMaxMs: config.sessionMaxMs,
      sessionIdleMs: config.sessionIdleMs,
    });
  }

  // POST /api/join — vérification d'un code de session (technicien authentifié)
  if (req.method === 'POST' && url.pathname === '/api/join') {
    if (!isAuthed(req)) return sendJson(res, 401, { error: 'auth-required' });
    const st = ipInfo(ip);
    const now = Date.now();
    if (!windowAllows(st.joinTimes, now, config.joinMaxPerMin, 60 * 1000)) {
      return sendJson(res, 429, { error: 'rate-limited' });
    }
    st.joinTimes.push(now);
    const body = await readJson(req);
    const code = body && typeof body.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { error: 'bad-code' });
    const session = sessions.get(code);
    if (!session) return sendJson(res, 404, { error: 'unknown-code' });
    // Le technicien publie sa clé publique éphémère ici (et non sur le canal
    // WebSocket, qui reste en réception seule) : la personne aidée la recevra
    // pour chiffrer à son intention. Le serveur ne peut pas en déduire la clé.
    const techPub = validPubkey(body && typeof body.techPub === 'string' ? body.techPub : '');
    session.techPub = techPub;
    // Traçabilité : qui (technicien) a consulté quelle session (personne aidée),
    // quand, et depuis quelles adresses — offusquées.
    logAccess(ip, session.ip, code);
    return sendJson(res, 200, {
      ok: true,
      userPub: session.userPub,
      salt: session.salt,
      crypto: session.userPub ? 'ecdh-p256-aesgcm' : 'none',
      techCrypto: techPub !== '',
      diag: session.diag || null,
    });
  }

  // POST /api/end — arrêt net décidé par le technicien. La personne aidée peut
  // avoir laissé son partage tourner (fenêtre oubliée) : la session est close
  // et la personne aidée prévenue par session-ended.
  if (req.method === 'POST' && url.pathname === '/api/end') {
    if (!isAuthed(req)) return sendJson(res, 401, { error: 'auth-required' });
    const body = await readJson(req);
    const code = body && typeof body.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { error: 'bad-code' });
    const session = sessions.get(code);
    if (!session) return sendJson(res, 404, { error: 'unknown-code' });
    endSession(session, 'tech-stopped');
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not-found' });
}

// ---------------------------------------------------------------------------
// WebSockets
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes + 65536 });

// Anti « cross-site WebSocket hijacking » : l'origine (navigateur) doit être la nôtre.
// Les clients non-navigateur (tests, scripts) n'envoient pas d'en-tête Origin.
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket) {
  socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

function handleUserMessage(session, data, isBinary) {
  if (isBinary) {
    if (data.length > config.maxFrameBytes) return endSession(session, 'frame-too-large');
    const now = Date.now();
    if (now - session.lastFrameTs < config.minFrameIntervalMs) return; // trames trop rapides : ignorées
    const w = session.byteWindow;
    if (now - w.t >= 10000) { w.t = now; w.bytes = 0; }
    w.bytes += data.length;
    if (w.bytes > config.maxBytesPerSec * 10) return endSession(session, 'rate-limit');
    session.lastFrameTs = now;
    session.lastFrameAt = now;
    if (session.techWs && session.techWs.readyState === WebSocket.OPEN) {
      session.techWs.send(data, { binary: true });
    }
    return;
  }
  if (data.length > 4096) return;
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg && msg.type === 'stop') endSession(session, 'user-stopped');
}

function handleUserUpgrade(req, socket, head, st) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    st.wsCount++;
    let session = null;
    const authTimer = setTimeout(() => {
      if (!session) { try { ws.close(1008, 'auth-timeout'); } catch { /* ignore */ } }
    }, 10000);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* géré par 'close' */ });

    ws.on('message', (data, isBinary) => {
      if (!session) {
        clearTimeout(authTimer);
        if (isBinary || data.length > 4096) return ws.close(1008, 'bad-auth');
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return ws.close(1008, 'bad-auth'); }
        if (!msg || msg.type !== 'auth' || typeof msg.token !== 'string') return ws.close(1008, 'bad-auth');
        const found = [...sessions.values()].find((s) => s.userToken === msg.token);
        if (!found) return ws.close(1008, 'unauthorized');
        session = found;
        session.userWs = ws;
        // La personne aidée annonce sa clé publique au moment de s'authentifier.
        session.userPub = validPubkey(typeof msg.userPub === 'string' ? msg.userPub : '');
        // Le technicien peut déjà être connecté : il lui faut notre clé publique.
        notifyUserKey(session);
        if (session.techWs && session.techWs.readyState === WebSocket.OPEN) {
          // Le technicien est déjà là : on transmet sa clé et on signale sa présence.
          notifyTechJoined(session);
          ws.send(JSON.stringify({
            type: 'tech-present',
            techPub: session.techPub,
            techCrypto: session.techPub !== '',
          }));
        }
        return;
      }
      handleUserMessage(session, data, isBinary);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      st.wsCount--;
      if (session && session.userWs === ws) {
        session.userWs = null;
        endSession(session, 'user-left');
      }
    });
  });
}

function handleTechUpgrade(req, socket, head, url, st) {
  const cookies = parseCookies(req);
  const auth = authSessions.get(cookies.sid);
  if (!auth || auth.expiresAt <= Date.now()) return rejectUpgrade(socket);
  const code = url.searchParams.get('code') || '';
  const session = sessions.get(code);
  if (!session) return rejectUpgrade(socket);

  wss.handleUpgrade(req, socket, head, (ws) => {
    st.wsCount++;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* ignore */ });
    ws.on('message', (data) => {
      // Le technicien est en réception seule pour les images. Seul message
      // accepté : l'arrêt net de session, quand il veut passer à la suivante
      // sans dépendre de la personne aidée.
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg && msg.type === 'stop') endSession(session, 'tech-stopped');
    });
    ws.on('close', () => {
      st.wsCount--;
      if (session.techWs === ws) {
        session.techWs = null;
        if (session.userWs && session.userWs.readyState === WebSocket.OPEN) {
          session.userWs.send(JSON.stringify({ type: 'tech-left' }));
        }
      }
    });
    if (session.techWs && session.techWs.readyState === WebSocket.OPEN) {
      try { session.techWs.close(4000, 'replaced'); } catch { /* ignore */ }
    }
    session.techWs = ws;
    // Le technicien reçoit le sel et la clé publique de la personne aidée, puis
    // cette dernière est prévenue de son arrivée (elle chiffrera pour lui seul).
    ws.send(JSON.stringify({
      type: 'joined',
      salt: session.salt,
      userPub: session.userPub,
      crypto: session.userPub ? 'ecdh-p256-aesgcm' : 'none',
    }));
    notifyTechJoined(session);
  });
}

// ---------------------------------------------------------------------------
// Serveur HTTP + routage WebSocket
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method-not-allowed' });
    }
    if (serveStatic(res, url.pathname)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('404');
  } catch (err) {
    try { sendJson(res, 500, { error: 'internal' }); } catch { /* ignore */ }
    console.error('[http]', err.message);
  }
});

server.on('upgrade', (req, socket, head) => {
  if (!originOk(req)) return rejectUpgrade(socket);
  const url = new URL(req.url, 'http://localhost');
  const ip = req.socket.remoteAddress || 'unknown';
  const st = ipInfo(ip);
  if (st.wsCount >= config.maxWsPerIp) return rejectUpgrade(socket);
  if (url.pathname === '/ws/user') return handleUserUpgrade(req, socket, head, st);
  if (url.pathname === '/ws/tech') return handleTechUpgrade(req, socket, head, url, st);
  rejectUpgrade(socket);
});

// Détection des connexions mortes
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

// Expiration automatique des sessions et nettoyage
setInterval(() => {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    if (now - session.createdAt > config.sessionMaxMs) endSession(session, 'max-duration');
    else if (now - session.lastFrameAt > config.sessionIdleMs) endSession(session, 'idle-timeout');
  }
}, 30000);

setInterval(() => {
  const now = Date.now();
  for (const [sid, auth] of authSessions) {
    if (auth.expiresAt <= now) authSessions.delete(sid);
  }
}, 600000);

server.listen(config.port, config.host, () => {
  console.log(`[start] easyhelper écoute sur http://${config.host}:${config.port}`);
  if (!config.techPasswordHash) {
    console.log('[config] ⚠ Aucun mot de passe technicien défini :  npm run set-password -- <mot-de-passe>');
  }
  console.log(
    `[config] sessions max : ${config.maxSessions} | durée max : ${Math.round(config.sessionMaxMs / 60000)} min | inactivité : ${Math.round(config.sessionIdleMs / 60000)} min`,
  );
});
