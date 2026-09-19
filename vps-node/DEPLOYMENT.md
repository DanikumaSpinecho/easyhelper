# Déploiement sur assistance.example.org

> **Vous êtes sur un hébergement mutualisé Hostinger (pas de VPS) ?**
> Suivez plutôt [`php-full/DEPLOYMENT.md`](../php-full/DEPLOYMENT.md) —
> la variante Node.js décrite ici nécessite un serveur dédié.

## Prérequis

- Un VPS (Debian 12 / Ubuntu 24.04 conseillés, 1 vCPU / 1 Go suffisent).
- Le domaine example.org avec un enregistrement DNS
  `A assistance.example.org → <IP du VPS>`.
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
sudo useradd -r -m -s /usr/sbin/nologin easyhelper
sudo mkdir -p /opt/easyhelper
sudo chown easyhelper:easyhelper /opt/easyhelper
# copier le CONTENU du dossier vps-node/ (git clone ou scp depuis votre poste), puis :
cd /opt/easyhelper
sudo -u easyhelper npm install --omit=dev
sudo -u easyhelper node scripts/set-password.js
#    -> saisir le mot de passe technicien (min. 8 caractères)
```

Le fichier `config.json` contient le haché du mot de passe : restreignez sa
lecture au service uniquement.

```bash
sudo chmod 600 /opt/easyhelper/config.json
```

## 3. Test rapide sans HTTPS

```bash
cd /opt/easyhelper
sudo -u easyhelper node server.js    # Ctrl+C pour arrêter
curl -s http://127.0.0.1:3080/ | head
curl -s -X POST http://127.0.0.1:3080/api/session
```

## 4. Service systemd

Créez `/etc/systemd/system/easyhelper.service` :

```ini
[Unit]
Description=EasyHelper support (relais de partage d'écran)
After=network.target

[Service]
Type=simple
User=easyhelper
Group=easyhelper
WorkingDirectory=/opt/easyhelper
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
sudo systemctl enable --now easyhelper
sudo systemctl status easyhelper
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
assistance.example.org {
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
curl -sI https://assistance.example.org/ | head -5            # page utilisateur
curl -s -X POST https://assistance.example.org/api/session    # création de session
curl -sI https://assistance.example.org/tech.html | head -5   # page technicien
```

Puis test réel : partagez depuis un ordinateur sur
https://assistance.example.org, et consultez l'écran depuis votre téléphone sur
https://assistance.example.org/tech.html.

## Supervision et journaux

Les journaux sont minimaux (début/fin de session : code, horodatage, durée,
motif — pas d'IP ni d'image) :

```bash
journalctl -u easyhelper -f
journalctl -u caddy -f   # journaux d'accès du reverse proxy
```

## Sauvegarde et changement de mot de passe

Sauvegardez `config.json` (contient le haché du mot de passe).

```bash
sudo -u easyhelper node /opt/easyhelper/scripts/set-password.js
sudo systemctl restart easyhelper
```

## Mise à jour

```bash
cd /opt/easyhelper
sudo -u easyhelper git pull          # ou re-copier les fichiers
sudo -u easyhelper npm install --omit=dev
sudo systemctl restart easyhelper
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
