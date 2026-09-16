# Déploiement sur support.spinecho.fr

> **Vous êtes sur un hébergement mutualisé Hostinger (pas de VPS) ?**
> Suivez plutôt [`hostinger-php/DEPLOYMENT.md`](hostinger-php/DEPLOYMENT.md) —
> la variante Node.js décrite ici nécessite un serveur dédié.

## Prérequis

- Un VPS (Debian 12 / Ubuntu 24.04 conseillés, 1 vCPU / 1 Go suffisent).
- Le domaine spinecho.fr avec un enregistrement DNS
  `A support.spinecho.fr → <IP du VPS>`.
- Ports **80 et 443** ouverts vers le serveur. Le port 3080 reste fermé :
  Node n'écoute que sur 127.0.0.1.

## 1. Installer Node.js 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v22.x attendu
```

## 2. Installer l'application

```bash
sudo useradd -r -m -s /usr/sbin/nologin spinecho
sudo mkdir -p /opt/spinecho-support
sudo chown spinecho:spinecho /opt/spinecho-support
# copier les fichiers (git clone ou scp depuis votre poste), puis :
cd /opt/spinecho-support
sudo -u spinecho npm install --omit=dev
sudo -u spinecho node scripts/set-password.js
#    -> saisir le mot de passe technicien (min. 8 caractères)
```

Le fichier `config.json` contient le haché du mot de passe : restreignez sa
lecture au service uniquement.

```bash
sudo chmod 600 /opt/spinecho-support/config.json
```

## 3. Test rapide sans HTTPS

```bash
cd /opt/spinecho-support
sudo -u spinecho node server.js    # Ctrl+C pour arrêter
curl -s http://127.0.0.1:3080/ | head
curl -s -X POST http://127.0.0.1:3080/api/session
```

## 4. Service systemd

Créez `/etc/systemd/system/spinecho-support.service` :

```ini
[Unit]
Description=Spinecho support (relais de partage d'écran)
After=network.target

[Service]
Type=simple
User=spinecho
Group=spinecho
WorkingDirectory=/opt/spinecho-support
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spinecho-support
sudo systemctl status spinecho-support
```

## 5. HTTPS avec Caddy (recommandé)

Caddy obtient et renouvelle les certificats Let's Encrypt automatiquement et
relaie les WebSockets sans configuration particulière.

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile` :

```
support.spinecho.fr {
    encode gzip
    reverse_proxy 127.0.0.1:3080
}
```

```bash
sudo systemctl reload caddy
```

Caddy écoute sur 80/443, termine le TLS et relaie tout vers Node en local.
Le cookie technicien est émis avec le flag `Secure` (config `cookieSecure:
true`, le défaut) : ne le désactivez jamais en production.

Alternative : nginx, avec la configuration « websocket upgrade » habituelle
(`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection
"upgrade";` et le `proxy_pass` vers 127.0.0.1:3080).

## 6. Pare-feu

```bash
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Le port 3080 n'est jamais exposé publiquement.

## 7. Vérifications finales

```bash
curl -sI https://support.spinecho.fr/ | head -5            # page utilisateur
curl -s -X POST https://support.spinecho.fr/api/session    # création de session
curl -sI https://support.spinecho.fr/tech.html | head -5   # page technicien
```

Puis test réel : partagez depuis un ordinateur sur
https://support.spinecho.fr, et consultez l'écran depuis votre téléphone sur
https://support.spinecho.fr/tech.html.

## Supervision et journaux

Les journaux sont minimaux (début/fin de session : code, horodatage, durée,
motif — pas d'IP ni d'image) :

```bash
journalctl -u spinecho-support -f
journalctl -u caddy -f   # journaux d'accès du reverse proxy
```

## Sauvegarde et changement de mot de passe

Sauvegardez `config.json` (contient le haché du mot de passe).

```bash
sudo -u spinecho node /opt/spinecho-support/scripts/set-password.js
sudo systemctl restart spinecho-support
```

## Mise à jour

```bash
cd /opt/spinecho-support
sudo -u spinecho git pull          # ou re-copier les fichiers
sudo -u spinecho npm install --omit=dev
sudo systemctl restart spinecho-support
```

## Points d'attention

- Le service repose uniquement sur des **connexions sortantes** des
  navigateurs : il n'ouvre aucun port entrant sur les postes des proches et
  ne contourne aucun filtrage réseau. Si un réseau bloque le domaine, le
  service n'est pas accessible — limite assumée, sans mécanisme de
  contournement.
- Un redémarrage du serveur termine les sessions en cours et déconnecte le
  technicien (les sessions sont volatiles par conception).
- Caddy journalise les requêtes (dont `/ws/tech?code=...`) : le code de
  session à 6 chiffres seul est inutilisable sans le cookie technicien, et le
  jeton utilisateur, lui, n'apparaît jamais dans les URL (envoyé en premier
  message WebSocket).
