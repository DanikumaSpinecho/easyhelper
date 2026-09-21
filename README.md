# EasyHelper — assistance à distance par partage d'écran (lecture seule)

EasyHelper permet à un technicien de **voir l'écran** d'une personne qu'il
aide pendant quelques minutes, afin de la guider oralement. Rien à installer,
aucune prise de contrôle, aucun enregistrement.

Le cas d'usage visé : apporter rapidement une **assistance de confiance** à
distance — ouvrir une application, retrouver un fichier ou connecter une
imprimante — sans attendre qu'un service informatique puisse se déplacer.

- **La personne aidée** ouvre une page web, clique sur **Partager mon écran**,
  autorise le partage (fenêtre, onglet ou écran entier) et lit un code à voix
  haute au téléphone.
- **Le technicien** ouvre la page technicien, s'authentifie, saisit le code :
  il voit l'écran en direct (1 à 3 images par seconde) le temps de
  l'assistance.
- La personne aidée arrête quand elle veut ; la session est immédiatement
  détruite côté serveur.

## Principes

- **Consentement explicite** — c'est la personne aidée qui déclenche le
  partage, avec l'autorisation native du navigateur, et son navigateur
  l'indique en permanence pendant la session.
- **Lecture seule** — aucun clic, aucune frappe, aucun contrôle à distance.
- **Aucune installation** — un simple navigateur, côté personne aidée comme
  côté technicien ; rien à déployer sur les postes de travail.
- **Aucune conservation** — les images ne sont pas enregistrées : supprimées à
  la fin de la session (10 min sans activité, 1 h au maximum).
- **Transparence réseau** — le service n'utilise que du **HTTPS standard
  (port 443)**, exactement comme n'importe quel site web consulté depuis le
  poste. Aucun port exotique, aucun logiciel à installer côté poste, aucune
  modification de configuration réseau, aucun accès entrant vers le poste de
  la personne aidée. Il s'intègre donc naturellement dans les environnements
  les plus encadrés — et il reste légitime : il n'ouvre aucun accès et ne
  contourne aucun contrôle.

> **Deux variantes d'hébergement**
>
> - **Hébergement mutualisé** (OVH, Hostinger, o2switch…) — **sans VPS** :
>   voir [`php-full/`](php-full/). PHP pur, images relayées en HTTPS
>   (envoi + lecture en attente), fonctionne sur un espace web classique.
> - **VPS / serveur dédié** : voir [`vps-node/`](vps-node/). Node.js +
>   WebSocket (2 à 4 images/s, meilleure latence).

## Compatibilité des navigateurs

| Usage | Chrome / Edge (ordinateur) | Firefox (ordinateur) | Safari (macOS) | Android | iPhone / iPad |
|---|---|---|---|---|---|
| Partager (personne aidée) | ✅ | ✅ (66+) | ✅ (13+) | ❌ | ❌ |
| Consulter (technicien) | ✅ | ✅ | ✅ | ✅ | ✅ |

Les navigateurs mobiles ne permettent **pas** le partage d'écran : l'API
`getDisplayMedia` est absente sur Android et iOS. La page l'explique
clairement au lieu d'afficher une erreur technique. La **consultation** côté
technicien fonctionne parfaitement sur téléphone et tablette.

Le partage exige une connexion **HTTPS** (contexte sécurisé), sauf en test
local sur `localhost`.

## Structure du dépôt

Le dépôt contient **deux variantes** du même service, chacune dans son dossier,
plus les tests qui les couvrent :

```
.
├── php-full/          Variante « hébergement mutualisé » (PHP pur, sans VPS)
│   ├── api.php, inc.php, cron.php, config.sample.php
│   ├── index.html, tech.html, style.css, crypto.js, user.js, tech.js
│   ├── deploy/        Script et hook de déploiement (git push)
│   └── test/          smoke.mjs (bout en bout du relais PHP)
├── vps-node/          Variante « VPS / serveur dédié » (Node.js + WebSocket)
│   ├── server.js
│   ├── public/        Pages et scripts servis aux navigateurs
│   ├── scripts/       set-password.js
│   ├── test/          ws-smoke.js (bout en bout du relais Node)
│   └── package.json
└── test/              Tests transverses aux deux variantes
    ├── crypto-interop.mjs   chiffrement (les deux variantes)
    ├── ui-zoom.mjs          interface : zoom, bannière, crédit
    ├── zoom-frame.mjs       mesure du cadre de zoom dans un vrai navigateur
    └── browser-e2e.mjs      parcours réel complet (vrai Chrome)
```

Les deux variantes partagent **le même `crypto.js`** (vérifié identique par
`test/crypto-interop.mjs`) et la même interface : une personne aidée servie par
une variante peut donc dialoguer avec un technicien connecté à l'autre.

Choisissez :

- **`php-full/`** — pas de VPS, un simple espace web mutualisé suffit
  (Hostinger, OVH, o2switch…). PHP + HTTPS, relais par envoi/lecture sur
  fichier temporaire.
- **`vps-node/`** — VPS ou serveur dédié : Node.js + WebSocket, 2 à 4 images/s
  et latence plus faible. Voir [`vps-node/DEPLOYMENT.md`](vps-node/DEPLOYMENT.md).

## Démarrage rapide (test local, variante Node.js)

```bash
cd vps-node
npm install
npm run set-password -- votre-mot-de-passe   # ou sans argument : saisie interactive
node server.js
```

Puis :

- http://localhost:3080 — page de la personne aidée
- http://localhost:3080/tech.html — page technicien

Ouvrez-les dans deux navigateurs différents (ou un onglet normal + un onglet
privé), partagez sur le premier, entrez le code sur le second.

Pour tester en HTTP (donc sans HTTPS), le cookie `Secure` empêche la connexion
du technicien : passez `cookieSecure` à `false` dans `config.json`
**uniquement pour un test local**.

## Architecture (variante Node.js)

Tout passe par le serveur, en HTTPS/WSS sur le port 443 (via un reverse
proxy). **Aucune connexion entrante** n'est requise vers le poste de la
personne aidée : seul le navigateur se connecte en sortant, ce qui fonctionne
derrière les NAT, les proxys d'entreprise, les hôtels et la 4G/5G — partout où
le web passe.

```
Personne aidée (navigateur)              serveur EasyHelper               Technicien (navigateur)
┌──────────────────────────┐         ┌─────────────────────┐              ┌──────────────────────┐
│ getDisplayMedia          │  JPEG   │  relais Node.js     │   JPEG       │  <img> live          │
│ + canvas JPEG 2–4 img/s  │ ──────► │  (en mémoire,       │   ──────►    │  (lecture seule)     │
└──────────────────────────┘   WSS   │  rien sur disque)   │    WSS       └──────────────────────┘
                                     └─────────────────────┘
```

- La personne aidée capture son écran via l'API standard `getDisplayMedia`
  (autorisation explicite, indicateur natif de partage du navigateur). Les
  images sont réduites à 1280 px de large, compressées en JPEG avec une
  qualité adaptative (~60–150 Ko), **chiffrées dans le navigateur** puis
  envoyées à ~3 images/s.
- Le serveur **ne stocke rien** : il relaie en mémoire et détruit la session à
  la fin. Une session se termine automatiquement après 10 min sans image ou
  1 h au total (réglable).
- Le technicien est authentifié par mot de passe (cookie HttpOnly,
  SameSite=Strict, Secure) **et** doit connaître le code de session.

Le relais d'images JPEG (plutôt que du WebRTC pair-à-pair) est le choix qui
maximise la compatibilité réseau : WebRTC exige un serveur TURN pour traverser
la plupart des NAT et échoue sur les réseaux qui filtrent l'UDP.

## Sécurité de la liaison entre la personne aidée et le technicien

Cette section décrit précisément **ce qui protège les images** pendant leur
 trajet, et **ce que le relais voit ou ne voit pas**. Elle vaut pour les deux
variantes (Node.js et PHP mutualisé) : le mécanisme cryptographique est
identique, seul le transport change.

### Le principe : une clé que le serveur ne peut pas connaître

L'idée tient en une phrase : **la clé qui chiffre les images est calculée dans
les deux navigateurs, et n'est jamais transmise**. Le serveur ne voit passer
que des clés **publiques** — à partir desquelles la clé de session ne peut pas
être calculée — et des images déjà **chiffrées**. Un serveur compromis, un
administrateur curieux ou un disque saisi ne donnent donc accès à **aucune
image lisible**.

### Déroulement réel (chiffrement de bout en bout)

```
   PERSONNE AIDÉE                    RELAIS (PHP ou Node)                TECHNICIEN
    navigateur                     ne voit que du public               navigateur
         │                                    │                              │
         │ ① paire de clés éphémère           │                              │
         │    ECDH P-256                      │                              │
         │    clé privée : ne sort JAMAIS     │                              │
         │                                    │                              │
         │ ② create { clé publique A } ──────►│ sel = 16 octets aléatoires   │
         │                                    │ mémorise : pub A, sel        │
         │                                    │                              │
         │                                    │◄──── ③ join { code, pub T } ─┤
         │                                    │ mémorise : pub T             │
         │                                    │                              │
         │ ④ status ◄─────────────────────────┤─── renvoie pub T + sel ─────►│
         │                                    │                              │
    ┌────┴─────────────────────┐              │            ┌─────────────────┴────┐
    │ clé = HKDF-SHA256(       │              │            │ clé = HKDF-SHA256(   │
    │   ECDH(privée A, pub T), │              │            │   ECDH(privée T, pub A),
    │   sel, "easyhelper/v1/frame")           │            │   sel, "easyhelper/v1/frame")
    └────┬─────────────────────┘              │            └─────────────────┬────┘
         │                                    │                              │
         │      ═══════ LA MÊME CLÉ AES-256, JAMAIS TRANSMISE ═══════        │
         │                                    │                              │
         │ ⑤ image JPEG                       │                              │
         │    chiffrée AES-256-GCM ──────────►│  octets opaques ────────────►│  déchiffre
         │    IV aléatoire de 12 octets       │  (aucune image lisible)      │  et affiche
```

Les étapes ① et ④ sont les seules où quelque chose est échangé ; à l'étape ⑤,
le relais transporte des octets qu'il ne sait pas interpréter.

### Ce que chaque partie connaît

| | Personne aidée | Relais | Technicien |
|---|---|---|---|
| Clé privée éphémère | oui | **non** | oui |
| Clé publique de l'autre | oui | oui (elle transite) | oui |
| Sel de dérivation | oui | oui (il le crée) | oui |
| **Clé de session AES-256** | oui | **non** | oui |
| Image en clair | oui | **jamais** | oui |

C'est le point décisif : le sel et les clés publiques peuvent être publics sans
affaiblir la sécurité. Recalculer la clé exigerait de résoudre le problème
Diffie-Hellman sur courbe elliptique, c'est-à-dire d'extraire une clé privée
qui n'a jamais quitté son navigateur.

### Garanties apportées

- **Confidentialité** — AES-256-GCM, clé dérivée par HKDF-SHA256, courbe P-256
  (niveau de sécurité équivalent à ~128 bits, standard des navigateurs).
- **Intégrité et authenticité de chaque image** — GCM est un chiffrement
  *authentifié* : toute altération d'un octet en transit fait échouer le
  déchiffrement, l'image corrompue est rejetée et jamais affichée.
- **Fraîcheur** — un IV aléatoire de 12 octets est tiré pour **chaque** image,
  ce qui empêche toute réutilisation de clé d'un cliché à l'autre.
- **Clés éphémères** — une paire neuve à chaque session : compromettre une
  session ne compromet aucune autre, ni les sessions passées.
- **Aucune conservation** — les images ne sont jamais écrites durablement :
  elles vivent en mémoire (Node) ou dans un fichier temporaire écrasé et
  supprimé en fin de session (PHP), et restent illisibles pour le relais.

### Limites, énoncées honnêtement

- **Un relais activement malveillant peut s'intercaler.** L'échange de clés
  n'est pas authentifié par un certificat : un serveur qui remplacerait les
  clés publiques par les siennes verrait les images. La protection porte donc
  contre un serveur **honnête mais curieux**, contre un accès à son stockage
  ou à son disque, et contre un tiers sur le réseau — pas contre l'opérateur du
  relais qui attaquerait activement. C'est un choix assumé : il n'y a rien à
  installer, et la personne aidée n'a rien d'autre à faire qu'accepter le
  partage.
- **Le mot de passe protège l'accès, pas la cryptographie.** Un technicien
  authentifié voit ce que la personne aidée a accepté de montrer — d'où
  l'importance du consentement explicite et de l'arrêt à tout moment.
- **Repli en clair assumé.** Si un navigateur ne sait pas chiffrer, le partage
  se poursuit sans chiffrement plutôt que de laisser la personne sans
  assistance (« ✅ connecté » reste affiché, le statut distingue les deux cas).
  Ce repli est visible dans le code et dans les échanges serveur.
- **Le code de session à 6 chiffres** est devinable en théorie : l'accès
  technicien est protégé par mot de passe et la vérification est limitée à
  30 essais par minute et par IP.

### Authentification et anti-abus

- **Technicien** — mot de passe haché scrypt (Node) ou `password_verify` (PHP),
  cookie/session HttpOnly, SameSite=Strict, Secure ; 10 tentatives par IP et
  par 15 minutes ; identifiant de session régénéré à la connexion.
- **Sessions temporaires** — code à 6 chiffres + jeton aléatoire de 256 bits
  (transmis en en-tête ou en premier message, **jamais dans l'URL** ni dans les
  journaux).
- **Séparation des rôles** — le canal de la personne aidée ne fait qu'envoyer,
  celui du technicien ne fait que recevoir ; aucun message de contrôle.
- **Anti-abus** — vérification de l'en-tête `Origin` sur les WebSockets
  (anti *cross-site WebSocket hijacking*) et en-têtes `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`.
- **Limites** — taille d'image, cadence, débit, nombre de sessions par IP ;
  expiration automatique (inactivité 10 min, 1 h au maximum).
- **Aucune fuite dans les journaux** — ni image, ni IP : uniquement
  début/fin de session (horodatage, durée, motif).

### Comment le vérifier soi-même

- `test/crypto-interop.mjs` — vérifie dans Node que le chiffrement correspond
  bien à ECDH P-256 + HKDF-SHA256 + AES-256-GCM, que deux parties
  indépendantes obtiennent **la même clé**, qu'une image altérée est
  **rejetée**, et que **les deux variantes publient le même `crypto.js`**.
- `test/browser-e2e.mjs` — déroule un vrai partage d'écran dans un vrai
  navigateur : les images arrivent déchiffrées, et le trafic ne contient que
  des octets opaques.
- Dans la page technicien, le statut indique « écran en direct (chiffré de bout
  en bout) » lorsque le chiffrement est actif : l'information est visible, pas
  dissimulée.

## Configuration (variante Node.js)

`config.json` est créé au premier démarrage. Options principales :

| Option | Défaut | Rôle |
|---|---|---|
| `port` / `host` | 3080 / 127.0.0.1 | Écoute locale (derrière le reverse proxy) |
| `techPasswordHash` | — | Haché scrypt du mot de passe (via `npm run set-password`) |
| `cookieSecure` | `true` | Flag Secure du cookie (mettre `false` uniquement en test HTTP) |
| `cookieTtlMs` | 12 h | Durée de la session technicien |
| `sessionIdleMs` | 10 min | Fin de session sans image |
| `sessionMaxMs` | 1 h | Durée maximale d'une session |
| `maxFrameBytes` | 262144 | Taille maximale d'une image |
| `minFrameIntervalMs` | 200 | Intervalle minimal entre deux images (5/s max) |
| `maxBytesPerSec` | 786432 | Débit maximal par session |
| `maxSessions` / `maxSessionsPerIp` | 20 / 3 | Sessions simultanées |
| `maxWsPerIp` | 12 | Connexions WebSocket simultanées par IP |
| `loginMaxAttempts` / `loginWindowMs` | 10 / 15 min | Anti force brute sur le login |

## Bande passante

≈ 2–3 Mbit/s en émission côté personne aidée (1280 px, ~3 images/s). En cas de
connexion faible, la qualité JPEG baisse automatiquement. Côté serveur, seule
la bande passante de relais est consommée : très léger pour un usage
occasionnel.

## Limites connues

- Pas d'audio (la conversation se fait par téléphone — c'est le scénario visé).
- Pas de partage d'écran depuis les navigateurs mobiles (limite des
  navigateurs eux-mêmes, pas du service) ; la consultation sur mobile
  fonctionne.
- Le redémarrage du serveur coupe les sessions en cours et déconnecte le
  technicien (par conception : tout est volatil).
- Pas d'enregistrement de session, ni côté personne aidée ni côté technicien.

## Tests

Les tests transverses se lancent depuis la racine (`npm install` une fois) :

```bash
npm run test-crypto       # chiffrement des deux variantes + interopérabilité
npm run test-ui           # interface : zoom, bannière d'état, crédit discret
npm run test-zoom-frame   # cadre de zoom mesuré dans un vrai navigateur
npm run test-browser      # parcours réel complet dans un vrai Chrome
```

Chaque variante a en plus son test de bout en bout sans navigateur :

```bash
# Relais Node.js — serveur lancé d'abord (cd vps-node && node server.js)
$env:TEST_PASSWORD='<mot-de-passe>'; npm run smoke --prefix vps-node

# Relais PHP — php -S 127.0.0.1:8080 -t php-full
$env:TEST_PASSWORD='<mot-de-passe>'; node php-full/test/smoke.mjs
```

`BASE=https://…` fait tourner les tests `zoom-frame` et `browser` contre un
site en production au lieu du serveur local : c'est la recette à passer avant
d'annoncer une correction.

## Licence

Copyright (C) 2026 EasyHelper contributors.

Ce programme est un logiciel libre : vous pouvez le redistribuer et/ou le
modifier selon les termes de la **GNU General Public License** telle que
publiée par la Free Software Foundation, version 3 de la licence (ou, à votre
convenance, toute version ultérieure).

Ce programme est distribué dans l'espoir qu'il sera utile, mais **sans aucune
garantie**. Voir le fichier [LICENSE](LICENSE) pour le texte complet.

Ce logiciel n'est **pas un dispositif médical** et ne fait l'objet d'aucune
certification. Il vise un niveau d'exigence élevé en matière de
confidentialité, au même titre que les outils utilisés en environnement de
soins.
