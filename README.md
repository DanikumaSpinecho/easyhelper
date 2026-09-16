# Aide à distance — support.spinecho.fr

> **Deux variantes d'hébergement**
>
> - **Hébergement mutualisé (Hostinger, OVH…) — sans VPS** : voir
>   [`hostinger-php/`](hostinger-php/) — PHP pur, images envoyées par HTTPS
>   (upload + long-polling), fonctionne sur votre espace web actuel.
> - **VPS** : la variante Node.js + WebSocket décrite dans ce README.

Partage d'écran ponctuel « vue seule » entre un proche (la personne aidée) et
vous (le technicien). **Aucun logiciel à installer, aucune prise de contrôle,
aucun enregistrement** : les images ne transitent qu'en mémoire pendant la
session, puis sont immédiatement supprimées.

## Comment ça marche

1. La personne aidée ouvre **https://support.spinecho.fr**, clique sur
   **Partager mon écran**. Le navigateur demande son autorisation explicite
   (choix de l'écran/onglet/fenêtre), puis affiche un **code à 6 chiffres**
   et un bandeau rouge « Partage en cours ».
2. Elle vous communique le code (par téléphone, par exemple).
3. Vous ouvrez **https://support.spinecho.fr/tech.html**, vous vous connectez
   avec votre mot de passe, vous saisissez le code : vous voyez son écran en
   direct (2 à 4 images par seconde). Vous la guidez oralement — vous ne
   pouvez ni cliquer ni taper à sa place.
4. Elle arrête le partage à tout moment avec **Arrêter le partage** (ou en
   fermant l'onglet). La session est immédiatement détruite côté serveur.

## Compatibilité des navigateurs

| Usage | Chrome / Edge (ordinateur) | Firefox (ordinateur) | Safari (macOS) | Android (Chrome / Firefox) | iPhone / iPad |
|---|---|---|---|---|---|
| Partager (personne aidée) | ✅ | ✅ (66+) | ✅ (13+) | ❌ | ❌ |
| Consulter (technicien) | ✅ | ✅ | ✅ | ✅ | ✅ |

Les navigateurs mobiles ne permettent **pas** le partage d'écran (l'API
`getDisplayMedia` est absente sur Android et iOS : Google et Mozilla l'ont
retirée, Apple ne l'a jamais activée). La page l'explique clairement au lieu
d'afficher une erreur technique. En revanche, la **consultation** côté
technicien fonctionne parfaitement sur téléphone et tablette.

Le partage exige une connexion **HTTPS** (contexte sécurisé), sauf en test
local sur `localhost`.

## Démarrage rapide (test local)

```bash
npm install
npm run set-password -- votre-mot-de-passe   # ou sans argument : saisie interactive
node server.js
```

Puis :

- http://localhost:3080 — page de la personne aidée
- http://localhost:3080/tech.html — page technicien

Ouvrez-les dans deux navigateurs différents (ou un onglet normal + un onglet
privé), partagez sur le premier, entrez le code sur le second.

Pour les tests en HTTP (donc sans HTTPS), le cookie `Secure` empêche la
connexion du technicien : passez `cookieSecure` à `false` dans `config.json`
**uniquement pour tester en local**.

## Architecture

Tout passe par le serveur, en HTTPS/WSS sur le port 443 (via un reverse
proxy). **Aucune connexion entrante** n'est requise vers le poste de la
personne aidée : seul le navigateur se connecte en sortant, ce qui fonctionne
derrière les NAT, les proxys d'entreprise, les hôtels et la 4G/5G — partout où
HTTPS passe. Aucun port UDP, aucun TURN/STUN, aucun mécanisme de contournement
de pare-feu : c'est un simple trafic HTTPS/WSS standard.

```
Personne aidée (navigateur)            support.spinecho.fr                 Technicien (navigateur)
┌──────────────────────────┐         ┌─────────────────────┐              ┌──────────────────────┐
│ getDisplayMedia          │  JPEG   │  relais Node.js     │   JPEG       │  <img> live          │
│ + canvas JPEG 2–4 img/s  │ ──────► │  (en mémoire,       │ ──────►      │  (lecture seule)     │
└──────────────────────────┘   WSS   │  rien sur disque)   │    WSS       └──────────────────────┘
                                     └─────────────────────┘
```

- La personne aidée capture son écran via l'API standard `getDisplayMedia`
  (autorisation explicite, indicateur natif de partage du navigateur). Les
  images sont réduites à 1280 px de large, compressées en JPEG avec qualité
  adaptative (~60–150 Ko), envoyées à ~3 images/s.
- Le serveur **ne stocke rien** : il relaye en mémoire et détruit la session à
  la fin. Une session se termine automatiquement après 10 min sans image ou
  1 h au total (réglable).
- Le technicien est authentifié par mot de passe (cookie HttpOnly,
  SameSite=Strict, Secure) **et** doit connaître le code à 6 chiffres.

Ce choix (relais WebSocket de captures JPEG plutôt que WebRTC P2P) est celui
qui maximise la compatibilité réseau : WebRTC exige un serveur TURN pour
traverser la plupart des NAT et échoue sur les réseaux qui bloquent l'UDP.

## Sécurité

- **Authentification du technicien** : mot de passe haché scrypt, cookie
  HttpOnly / SameSite=Strict / Secure, limitation des tentatives par IP
  (10 par 15 min).
- **Sessions temporaires** : code à 6 chiffres + jeton utilisateur de 256 bits
  (envoyé en premier message WebSocket, jamais dans les URL ni les journaux).
- **Séparation des rôles** : le canal utilisateur ne fait qu'envoyer ; le
  canal technicien ne fait que recevoir. Aucun message de contrôle n'existe.
- **Limites** : 256 Ko/image max, 5 images/s max, ~768 Ko/s max par session,
  20 sessions simultanées (3 par IP), 12 connexions WebSocket par IP.
- **Expiration automatique** : inactivité 10 min, durée totale 1 h, session
  technicien 12 h.
- **Aucune conservation** : aucune image écrite sur disque, tampons libérés à
  la fermeture. Journaux minimaux : début/fin de session (code, horodatage,
  durée, motif) — jamais d'image ni d'IP.
- **Anti-abus / anti-DoS** : vérification de l'en-tête `Origin` sur les
  WebSockets (anti *cross-site WebSocket hijacking*), limites de débit et de
  taille ci-dessus, en-têtes CSP, X-Frame-Options DENY, nosniff,
  Referrer-Policy.

## Configuration

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

≈ 2–3 Mbit/s en émission côté personne aidée (1280 px, ~3 images/s). En cas
de connexion faible, la qualité JPEG baisse automatiquement. Côté serveur,
seule la bande passante de relais est consommée : très léger pour un usage
familial occasionnel.

## Limites connues (v1)

- Pas d'audio (la conversation se fait par téléphone — c'est le scénario visé).
- Pas de partage d'écran depuis les navigateurs mobiles (limite des
  navigateurs eux-mêmes, pas du service) ; la consultation sur mobile
  fonctionne.
- Le redémarrage du serveur coupe les sessions en cours et déconnecte le
  technicien (par conception : tout est volatil).
- Pas de repli « HTTP POST » si un réseau bloquait même les WebSockets sur
  443 — un tel réseau bloque alors quasiment tout HTTPS ; extension possible
  si le besoin apparaît.

## Pistes d'évolution (volontairement non incluses)

- WebRTC direct (P2P) quand les deux côtés sont sur le même réseau local,
  pour économiser la bande passante du serveur (nécessite un TURN dans les
  autres cas — raison de son absence en v1).
- Plusieurs techniciens simultanés, petite page de statistiques, capture de
  l'audio système, adaptation automatique de la cadence selon la latence.

## Tests

Un test de bout en bout sans navigateur valide le relais, l'authentification
et le cycle de vie des sessions :

```bash
node server.js   # dans un premier terminal
$env:TEST_PASSWORD='<mot-de-passe>'; npm run smoke   # PowerShell, autre terminal
```
