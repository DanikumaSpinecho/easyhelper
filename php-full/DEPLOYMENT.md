# Déploiement sur hébergement mutualisé Hostinger

Pas de VPS, pas de Node.js, pas de WebSocket : uniquement PHP (7.4+, 8.x
conseillé) et HTTPS. Durée : ~10 minutes.

## Étape 1 — Préparer la configuration

Sur votre ordinateur :

1. Copiez `config.sample.php` vers `config.php`.
2. Modifiez `tech_password` (min. 8 caractères, un mot de passe que vous seul
   connaissez).
   - Option plus stricte : renseignez `tech_password_hash` avec la sortie de
     `password_hash()` et videz `tech_password`.
3. (Optionnel) Renseignez `cron_key` avec une longue chaîne aléatoire si vous
   voulez appeler le cron par HTTP.

## Étape 2 — Créer le sous-domaine

hPanel → **Sites web** → votre domaine → **Sous-domaines** → créer
`assistance.example.org` (document root créé automatiquement :
`public_html/assistance.example.org`).

> Pas de sous-domaine disponible sur votre plan ? Mettez le dossier dans
> `public_html/support` : le service sera alors accessible sur
> `https://example.org/support/` (les liens des pages sont relatifs, tout
> fonctionne).

## Étape 3 — Envoyer les fichiers

Envoyez **tous** ces fichiers dans le document root du sous-domaine :

```
api.php          inc.php          cron.php          config.php
index.html       tech.html        style.css         user.js      tech.js
.htaccess        data/.htaccess   config.sample.php (facultatif)
```

Méthodes possibles :

- **Gestionnaire de fichiers hPanel** : compressez le dossier en `.zip`,
  téléversez-le, puis « Extraire ».
- **FTP** (FileZilla) : identifiants FTP dans hPanel → Comptes FTP.
- **SSH** (plans Business et supérieurs) : `rsync`/`git`.

## Étape 4 — Permissions et HTTPS

1. hPanel → Gestionnaire de fichiers → `config.php` → Permissions → `0600`.
2. hPanel → **Sécurité** → **SSL** : installer le certificat gratuit
   (Let's Encrypt) pour `assistance.example.org` et forcer HTTPS.

## Étape 5 — Vérifier

Ouvrez :

```
https://assistance.example.org/api.php?action=selftest
```

Vous devez obtenir un JSON avec :

- `"password_configured": true`
- `"data_writable": true`

Le dossier `data/` est créé automatiquement à la première requête (le code le
crée s'il est absent — aucun réglage nécessaire).

## Étape 6 — Cron de nettoyage (recommandé)

hPanel → **Avancé** → **Tâches cron** → nouvelle tâche, toutes les **5 min** :

```
php /home/uXXXXXXXXX/domains/example.org/public_html/assistance.example.org/cron.php
```

(adaptez le chemin — il est affiché dans hPanel). Sans cron, le nettoyage se
fait quand même automatiquement à chaque requête de l'API.

## Étape 7 — Test réel

1. Ordinateur (personne aidée) : `https://assistance.example.org/` → Partager
   mon écran → code.
2. Votre téléphone (technicien) : `https://assistance.example.org/tech.html` →
   mot de passe → code → l'écran apparaît.

## Cas particuliers

- **CDN / cache Hostinger activé sur le domaine** : si les images semblent
  retardées, désactivez le cache/CDN pour le sous-domaine. Les en-têtes
  `Cache-Control: no-store` sont déjà envoyés par l'API, mais un CDN mal
  configuré peut tout de même intercepter les réponses.
- **« 503 Service non configuré » à la connexion** : `config.php` absent ou
  `tech_password` vide.
- **Erreurs de permissions sur `data/`** : supprimez le dossier s'il a été
  créé avec de mauvais droits, il sera recréé automatiquement.

## Limites du mutualisé (assumées)

- Fluidité ~2-3 images/s (suffisant pour guider quelqu'un au téléphone, mais
  ce n'est pas de la vidéo 30 i/s).
- Pas d'audio (la conversation se fait par téléphone — scénario visé).
- 1 à 3 partages simultanés confortablement (10 max configurable). Si un jour
  vous voulez de la vidéo fluide ou l'audio, la variante Node.js de ce dépôt
  (racine) est prête pour un petit VPS.

## Déploiement par git push (en place)

Un dépôt git nu est installé sur le serveur, hors racine web :
`/home/uXXXXXXXXX/repos/easyhelper.git`. Pousser la branche `deploy-hostinger`
déploie automatiquement dans `public_html/support` (hook `post-receive`,
source dans `php-full/deploy/`).

Les fichiers non suivis par git ne sont jamais touchés : `config.php`
(mot de passe technicien) et `data/` (sessions en cours) restent en place.

Depuis le poste de développement :

```bash
powershell -File php-full/deploy/build-deploy.ps1   # reconstruit la branche
git push deploy deploy-hostinger:deploy-hostinger   # déploie
```
