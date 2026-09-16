<?php
// ---------------------------------------------------------------------------
// spinecho-support — configuration
// Copiez ce fichier vers config.php, puis remplissez.
// Comme pour wp-config.php, ce fichier est exécuté côté serveur : il n'est
// jamais renvoyé tel quel aux visiteurs. Ne le publiez jamais (pas de dépôt
// git public, pas de copie).
// ---------------------------------------------------------------------------

return [

    // Mot de passe du technicien (obligatoire, min. 8 caractères).
    'tech_password' => 'changez-moi',

    // Alternative recommandée : un haché généré par password_hash().
    // S'il est renseigné (non vide), il remplace 'tech_password'.
    // Génération (PHP CLI, si vous y avez accès) :
    //   php -r "echo password_hash('votre-mot-de-passe', PASSWORD_DEFAULT);"
    'tech_password_hash' => '',

    // Durées (ms) : fin de session après 10 min sans image, durée totale max 1 h.
    'session_idle_ms' => 600000,
    'session_max_ms' => 3600000,

    // Limites : 200 Ko/image, 2,5 images/s max par session,
    // 10 sessions simultanées (2 par IP).
    'max_frame_bytes' => 200000,
    'frame_min_interval_ms' => 400,
    'max_sessions' => 10,
    'max_sessions_per_ip' => 2,

    // Attente maximale du « long-polling » côté technicien (ms).
    // Baissez à ~500 pour un test local avec le serveur PHP intégré
    // (php -S, mono-processus).
    'fetch_wait_ms' => 8000,

    // Anti force brute : 10 tentatives de connexion max par IP sur 15 min.
    'login_max_attempts' => 10,
    'login_window_ms' => 900000,

    // Limites de création de session et de vérification de code (par IP, par minute).
    'create_max_per_min' => 6,
    'join_max_per_min' => 30,

    // Optionnel : clé permettant d'appeler cron.php par HTTP (sinon CLI uniquement).
    'cron_key' => '',
];
