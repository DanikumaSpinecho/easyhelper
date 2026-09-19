// easyhelper — chiffrement de bout en bout des images.
//
// Principe : la personne aidée et le technicien échangent des clés publiques
// éphémères ECDH (courbe P-256). Chacun calcule de son côté un secret partagé
// dont on dérive une clé AES-256-GCM (HKDF-SHA256). Les images sont chiffrées
// dans le navigateur de la personne aidée et déchiffrées dans celui du
// technicien : le serveur ne voit que des octets opaques et des clés PUBLIQUES,
// à partir desquelles la clé de session ne peut pas être calculée.
//
// Aucune interaction ajoutée : la clé est négociée automatiquement pendant le
// partage. Si un navigateur ne dispose pas de l'API de chiffrement, le relais
// continue en clair (aucun message d'erreur n'est imposé à la personne aidée).
(() => {
  'use strict';

  const subtle = (window.crypto && window.crypto.subtle) ? window.crypto.subtle : null;
  const INFO = new TextEncoder().encode('easyhelper/v1/frame');

  let keyPair = null;   // paire éphémère locale (jamais exportée en privé)
  let encKey = null;    // clé AES-GCM de session
  let peerId = '';      // empreinte de la clé publique du pair
  let peerSalt = '';    // sel de dérivation (fourni par le serveur)

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromB64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function fromHex(s) {
    if (!s || s.length % 2) return new Uint8Array(0);
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  async function ensureKeys() {
    if (keyPair || !subtle) return keyPair;
    try {
      keyPair = await subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    } catch {
      keyPair = null;
    }
    return keyPair;
  }

  async function pubkey() {
    const kp = await ensureKeys();
    if (!kp) return '';
    try {
      return toB64(await subtle.exportKey('raw', kp.publicKey));
    } catch {
      return '';
    }
  }

  // Dérive (ou réutilise) la clé AES-GCM à partir de la clé publique du pair.
  async function derive(peerPub, saltHex) {
    const kp = await ensureKeys();
    if (!kp || !peerPub) return null;
    if (encKey && peerId === peerPub) return encKey;
    try {
      const peer = await subtle.importKey(
        'raw', fromB64(peerPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, kp.privateKey, 256);
      const hkdf = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
      encKey = await subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: fromHex(saltHex || ''),
          info: INFO,
        },
        hkdf,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']);
      peerId = peerPub;
      peerSalt = saltHex || '';
      return encKey;
    } catch {
      encKey = null;
      return null;
    }
  }

  // Cadre chiffré : [12 octets d'IV][texte chiffré + tag GCM]
  async function encryptFrame(bytes) {
    if (!encKey) return null;
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, encKey, bytes);
      const out = new Uint8Array(12 + ct.byteLength);
      out.set(iv, 0);
      out.set(new Uint8Array(ct), 12);
      return out;
    } catch {
      return null;
    }
  }

  async function decryptFrame(bytes) {
    if (!encKey || bytes.byteLength < 29) return null;
    try {
      const iv = bytes.slice(0, 12);
      const ct = bytes.slice(12);
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, encKey, ct));
    } catch {
      return null;
    }
  }

  window.EHCrypto = {
    available: !!subtle,
    pubkey,
    derive,
    encryptFrame,
    decryptFrame,
    hasKey: () => !!encKey,
    sharedSalt: () => peerSalt,
  };
})();
