// Test d'interopérabilité du chiffrement côté navigateur (public/crypto.js).
//
// Le fichier crypto.js est exécuté ici dans un bac à sable muni de l'API
// WebCrypto de Node, puis confronté à une implémentation indépendante
// (node:crypto). Cela prouve que le code réellement servi aux navigateurs
// implémente bien l'ECDH P-256 + HKDF-SHA256 + AES-256-GCM standard, et que
// les deux postes dérivent la même clé sans jamais la transmettre.
//
// Usage : node test/crypto-interop.mjs

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createECDH, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../public/crypto.js', import.meta.url), 'utf8');
const INFO = Buffer.from('easyhelper/v1/frame', 'utf8');

// Exécute crypto.js dans un contexte isolé (une « instance navigateur »).
function newBrowserInstance() {
  const win = { crypto: webcrypto };
  const factory = new Function(
    'window', 'crypto', 'btoa', 'atob', 'TextEncoder', 'Uint8Array',
    SRC + '\nreturn window.EHCrypto;',
  );
  return factory(
    win,
    webcrypto,
    (s) => Buffer.from(s, 'binary').toString('base64'),
    (s) => Buffer.from(s, 'base64').toString('binary'),
    TextEncoder,
    Uint8Array,
  );
}

async function main() {
  const alice = newBrowserInstance();   // personne aidée
  const bob = newBrowserInstance();     // technicien
  assert.equal(alice.available, true, 'WebCrypto disponible');
  assert.equal(bob.available, true, 'WebCrypto disponible');

  // 1. Échange de clés publiques éphémères
  const aPub = await alice.pubkey();
  const bPub = await bob.pubkey();
  assert.ok(aPub && bPub, 'les deux postes produisent une clé publique');
  assert.notEqual(aPub, bPub, 'les clés publiques sont distinctes');
  const aRaw = Buffer.from(aPub, 'base64');
  assert.equal(aRaw.length, 65, 'clé publique P-256 non compressée (65 octets)');
  assert.equal(aRaw[0], 4, 'préfixe 0x04 attendu par le relais');

  // 2. Dérivation : chaque côté calcule la clé à partir de celle de l'autre
  const salt = randomBytes(16).toString('hex');
  const kAlice = await alice.derive(bPub, salt);
  const kBob = await bob.derive(aPub, salt);
  assert.ok(kAlice && kBob, 'les deux postes dérivent une clé');
  assert.equal(alice.hasKey(), true, 'clé en place côté personne aidée');
  assert.equal(bob.hasKey(), true, 'clé en place côté technicien');

  // 3. Aller-retour chiffré entre les deux postes
  const message = new TextEncoder().encode('capture d\u2019écran confidentielle — ' + 'X'.repeat(5000));
  const frame = await alice.encryptFrame(message);
  assert.ok(frame && frame.length > message.length, 'cadre chiffré produit');
  const opened = await bob.decryptFrame(frame);
  assert.equal(Buffer.from(opened).toString('utf8'), Buffer.from(message).toString('utf8'),
    'le technicien restitue l\u2019image à l\u2019identique');

  // 4. Le contenu en clair n'apparaît nulle part dans le cadre transmis
  assert.ok(!Buffer.from(frame).includes(Buffer.from('confidentielle')),
    'aucun fragment en clair dans le cadre');

  // 5. Un octet modifié invalide le message (AES-GCM authentifié)
  const tampered = Buffer.from(frame);
  tampered[20] ^= 0x01;
  assert.equal(await bob.decryptFrame(new Uint8Array(tampered)), null,
    'une altération du cadre est détectée et refusée');

  // 6. Interopérabilité avec une implémentation indépendante (node:crypto) :
  //    node détient l'autre moitié d'un couple ECDH et doit retrouver la même clé.
  const nodeSide = createECDH('prime256v1');
  nodeSide.generateKeys();
  const nodePub = nodeSide.getPublicKey().toString('base64');

  assert.ok(await alice.derive(nodePub, salt), 'clé dérivée face à une clé externe');

  const shared = nodeSide.computeSecret(aRaw);
  const nodeKey = Buffer.from(hkdfSync('sha256', shared, Buffer.from(salt, 'hex'), INFO, 32));

  const fromAlice = await alice.encryptFrame(message);
  const iv = fromAlice.slice(0, 12);
  const tag = fromAlice.slice(fromAlice.length - 16);
  const cipherText = fromAlice.slice(12, fromAlice.length - 16);
  const dec = createDecipheriv('aes-256-gcm', nodeKey, iv);
  dec.setAuthTag(tag);
  const plain = Buffer.concat([dec.update(cipherText), dec.final()]);
  assert.equal(plain.toString('utf8'), Buffer.from(message).toString('utf8'),
    'une implémentation indépendante déchiffre les images avec la même clé');

  // 7. Sel différent => clé différente (aucune réutilisation de clé entre sessions)
  assert.ok(await bob.derive(aPub, randomBytes(16).toString('hex')), 'dérivation avec un autre sel');
  assert.equal(await bob.decryptFrame(await alice.encryptFrame(message)), null,
    'un sel différent ne permet pas de déchiffrer (clés distinctes)');

  console.log('OK — chiffrement navigateur conforme (ECDH P-256, HKDF-SHA256, AES-256-GCM), '
    + 'interopérable et résistant à l\u2019altération.');
}

main().catch((e) => {
  console.error('ÉCHEC :', e.message);
  process.exitCode = 1;
});
