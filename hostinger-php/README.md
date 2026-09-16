# Aide à distance — version hébergement mutualisé (Hostinger)

Variante **PHP pur** du relais de partage d'écran « vue seule » : elle
fonctionne sur un hébergement mutualisé classique (Hostinger, OVH, o2switch…)
sans Node.js, sans WebSocket, sans VPS. Le fonctionnement est identique à la
variante Node.js (voir le README racine) :

1. La personne aidée ouvre la page, clique **Partager mon écran** → un code à
   6 chiffres s'affiche avec un bandeau rouge « Partage en cours ».
2. Elle vous communique le code par téléphone.
3. Vous ouvrez la page technicien, vous vous connectez avec votre mot de
   passe, vous saisissez le code → l'écran s'affiche en direct (2 à 3 images
   par seconde). Vous la guidez oralement : aucune prise de contrôle.
4. Elle arrête à tout moment ; la session est immédiatement supprimée.

**Rien n'est enregistré** : les images sont des fichiers temporaires purgés à
la fin de la session (10 min d'inactivité / 1 h maximum).

## Compatibilité des navigateurs

| Usage | Chrome / Edge (PC) | Firefox (PC) | Safari (macOS) | Android | iPhone / iPad |
|---|---|---|---|---|---|
| Partager (personne aidée) | ✅ | ✅ 66+ | ✅ 13+ | ❌ | ❌ |
| Consulter (technicien) | ✅ | ✅ | ✅ | ✅ | ✅ |

Les navigateurs mobiles ne permettent pas le partage d'écran (API absente) :
la page l'explique clairement. La consultation côté technicien fonctionne sur
mobile. Le partage exige le HTTPS (sauf localhost).

## Fonctionnement technique

Sur un hébergement mutualisé, pas de processus permanent ni de WebSocket. Le
relais utilise donc le HTTPS standard, seule chose disponible partout :

```
Personne aidée (navigateur)          Hébergement Hostinger                    Technicien (navigateur)
getDisplayMedia + canvas JPEG ──► POST api.php?action=upload ──► fichier ──► GET api.php?action=fetch
     2–3 img/s, 1280 px              temporaire + métadonnées                 (long-polling, image/jpeg)
```

- L'image courante est écrite de façon **atomique** (fichier temporaire +
  renommage) : le technicien ne voit jamais une image tronquée.
- Le technicien fait du **long-polling** : une seule requête attend jusqu'à
  8 s qu'une nouvelle image arrive (au lieu de marteler le serveur), puis
  renvoie immédiatement l'image suivante. Latence typique < 500 ms.
- La présence du technicien est détectée côté serveur : la page de la
  personne aidée affiche « ✅ Votre proche est connecté ».

## Sécurité (identique à la variante Node.js)

- **Authentification technicien** : mot de passe (haché scrypt → ici
  `password_verify`/`hash_equals`), session PHP cookie HttpOnly /
  SameSite=Strict / Secure, anti force brute par IP (10 tentatives / 15 min).
- **Sessions temporaires** : code à 6 chiffres + jeton utilisateur de
  256 bits (envoyé en en-tête HTTP, jamais dans les URL).
- **Séparation des rôles** : la personne aidée ne fait qu'envoyer, le
  technicien ne fait que recevoir.
- **Limites** : 200 Ko/image, 2,5 images/s, 10 sessions (2 par IP),
  créations limitées à 6/min/IP.
- **Expiration** : 10 min sans image, 1 h au total, purge automatique
  (à chaque requête + cron optionnel).
- **Aucune conservation** : fichiers supprimés en fin de session ; le dossier
  `data/` est interdit d'accès web (`.htaccess` + `RedirectMatch 403`).
- **Anti-abus** : requêtes JSON (protégées par la politique CORS par défaut),
  limites de débit, en-têtes CSP/no-store/nosniff.

## Configuration

Copiez `config.sample.php` vers `config.php` et renseignez au minimum
`tech_password` (min. 8 caractères). Toutes les limites sont réglables dans ce
fichier. En production, mettez `config.php` en permissions 600.

## Test local (optionnel, si PHP est installé sur votre machine)

```bash
php -S 127.0.0.1:8080 -t hostinger-php
# config.php local : tech_password = 'devpass123', fetch_wait_ms = 500
# (le serveur intégré de PHP est mono-processus : un long-polling de 8 s
#  bloquerait les envois d'images — d'où le fetch_wait_ms réduit en local)
```

Dans un autre terminal :

```powershell
$env:TEST_PASSWORD='***'; node hostinger-php/test/smoke.mjs
```

Le test couvre : création de session, connexion (bon/mauvais mot de passe),
vérification de code, refus sans authentification, upload + récupération de
l'image (taille et contenu), cadence limitée, arrêt → session supprimée,
image trop grande refusée.

## Déploiement

Voir [DEPLOYMENT.md](DEPLOYMENT.md) — environ 10 minutes sur Hostinger.
