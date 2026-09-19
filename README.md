# EasyHelper — assistance à distance par partage d'écran (lecture seule)

EasyHelper permet à un technicien de **voir l'écran** d'une personne qu'il
aide pendant quelques minutes, afin de la guider oralement. Rien à installer,
aucune prise de contrôle, aucun enregistrement.

Le cas d'usage visé : apporter rapidement une **assistance de confiance** à une
personne peu à l'aise avec l'informatique — par exemple un soignant en milieu
hospitalier qui doit retrouver un dossier, ouvrir une application métier ou
connecter une imprimante, sans attendre qu'un service informatique puisse se
déplacer.

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
>   voir [`hostinger-php/`](hostinger-php/). PHP pur, images relayées en HTTPS
>   (envoi + lecture en attente), fonctionne sur un espace web classique.
> - **VPS / serveur dédié** : variante Node.js + WebSocket décrite ci-dessous
>   (2 à 4 images/s, meilleure latence).

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

## Démarrage rapide (test local, variante Node.js)

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
  qualité adaptative (~60–150 Ko), envoyées à ~3 images/s.
- Le serveur **ne stocke rien** : il relaie en mémoire et détruit la session à
  la fin. Une session se termine automatiquement après 10 min sans image ou
  1 h au total (réglable).
- Le technicien est authentifié par mot de passe (cookie HttpOnly,
  SameSite=Strict, Secure) **et** doit connaître le code de session.

Le relais d'images JPEG (plutôt que du WebRTC pair-à-pair) est le choix qui
maximise la compatibilité réseau : WebRTC exige un serveur TURN pour traverser
la plupart des NAT et échoue sur les réseaux qui filtrent l'UDP.

## Sécurité

- **Authentification du technicien** — mot de passe haché scrypt, cookie
  HttpOnly / SameSite=Strict / Secure, limitation des tentatives par IP
  (10 par 15 min).
- **Sessions temporaires** — code de session + jeton utilisateur de 256 bits
  (envoyé en en-tête ou en premier message, jamais dans l'URL ni les journaux).
- **Séparation des rôles** — le canal « personne aidée » ne fait qu'envoyer ;
  le canal « technicien » ne fait que recevoir. Aucun message de contrôle.
- **Limites** — taille et cadence des images, nombre de sessions par IP,
  débit maximal par session.
- **Expiration automatique** — inactivité 10 min, durée totale 1 h, session
  technicien 12 h.
- **Aucune conservation** — journaux minimaux (début/fin de session :
  horodatage, durée, motif) ; jamais d'image ni d'IP.
- **Anti-abus** — vérification de l'en-tête `Origin` sur les WebSockets
  (anti *cross-site WebSocket hijacking*), limites de débit et de taille,
  en-têtes CSP, X-Frame-Options DENY, nosniff, Referrer-Policy.

**Objectif de sécurité (feuille de route)** : chiffrement de bout en bout des
images, afin qu'un tiers ne puisse pas les exploiter — y compris un tiers ayant
accès au serveur ou à son disque. La clé reste dans les deux navigateurs.

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

Un test de bout en bout sans navigateur valide le relais, l'authentification
et le cycle de vie des sessions :

```bash
node server.js   # dans un premier terminal
$env:TEST_PASSWORD='<mot-de-passe>'; npm run smoke   # PowerShell, autre terminal
```

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
