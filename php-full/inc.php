<?php
/**
 * easyhelper — relais PHP pour hébergement mutualisé (Hostinger, etc.)
 * Fonctions partagées entre api.php et cron.php.
 * Rien n'est enregistré durablement : les images sont des fichiers
 * temporaires supprimés à la fin de chaque session.
 */

declare(strict_types=1);

define('APP_DIR', __DIR__);
define('DATA_DIR', __DIR__ . '/data');
define('SESSIONS_DIR', DATA_DIR . '/sessions');

$DEFAULTS = [
    'tech_password' => '',          // mot de passe technicien (voir config.sample.php)
    'tech_password_hash' => '',     // alternative : haché password_hash()
    'session_idle_ms' => 600000,    // fin si aucune image pendant 10 min
    'session_max_ms' => 3600000,    // durée maximale d'une session : 1 h
    // La personne aidée appelle le serveur en continu pendant un partage (1 à
    // 4 s). Au-delà de ce délai sans aucun appel, sa fenêtre a été fermée ou son
    // navigateur est tombé : la session est terminée et l'image effacée, sans
    // attendre les 10 min d'inactivité.
    'client_gone_ms' => 120000,
    'max_frame_bytes' => 200000,    // taille maximale d'une image
    'frame_min_interval_ms' => 400, // 2,5 images/s max par session
    'max_sessions' => 10,           // sessions simultanées (total)
    'max_sessions_per_ip' => 2,     // par IP
    'fetch_wait_ms' => 8000,        // attente max du long-polling technicien
    'login_max_attempts' => 10,     // anti force brute : tentatives par IP…
    'login_window_ms' => 900000,    // …sur 15 min
    'create_max_per_min' => 6,      // créations de session par minute et par IP
    'join_max_per_min' => 30,       // vérifications de code par minute et par IP
    'cron_key' => '',               // optionnel : clé pour appeler cron.php par HTTP
];

$CONFIG = is_file(APP_DIR . '/config.php')
    ? array_merge($DEFAULTS, require APP_DIR . '/config.php')
    : $DEFAULTS;

if (!is_dir(DATA_DIR)) @mkdir(DATA_DIR, 0775, true);
if (!is_dir(SESSIONS_DIR)) @mkdir(SESSIONS_DIR, 0775, true);

function now_ms(): int
{
    return (int) round(microtime(true) * 1000);
}

function client_ip(): string
{
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

function is_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') return true;
    return ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

function valid_code(string $code): string
{
    return preg_match('/^\d{6}$/', $code) ? $code : '';
}

function json_out(int $status, array $payload): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload);
    exit;
}

function meta_path(string $code): string
{
    return SESSIONS_DIR . "/meta_{$code}.json";
}

function frame_path(string $code): string
{
    // Contenu opaque : soit une image JPEG (anciens clients), soit un
    // chiffré AES-GCM (image + IV). Le serveur ne l'interprète jamais.
    return SESSIONS_DIR . "/frame_{$code}.bin";
}

function frame_path_legacy(string $code): string
{
    return SESSIONS_DIR . "/frame_{$code}.jpg";
}

function presence_path(string $code): string
{
    return SESSIONS_DIR . "/presence_{$code}.txt";
}

/**
 * Termine une session et efface IMMÉDIATEMENT l'image stockée.
 *
 * La suppression ne peut pas attendre le nettoyage périodique : une session
 * close ne doit laisser aucun écran derrière elle, même si personne ne
 * relance de nettoyage avant plusieurs minutes. La métadonnée est conservée
 * pour que le technicien apprenne la fin et son motif.
 */
function end_session(string $code, string $reason, ?array $meta = null): void
{
    $meta = $meta ?? load_meta($code);
    if ($meta === null) return;
    if (empty($meta['ended'])) {
        $meta['ended'] = $reason;
        save_meta($code, $meta);
    }
    @unlink(frame_path($code));
    @unlink(frame_path_legacy($code));
    @unlink(presence_path($code));
    @unlink(SESSIONS_DIR . "/tmpframe_{$code}.tmp");
}

function load_meta(string $code): ?array
{
    $path = meta_path($code);
    if (!is_file($path)) return null;
    $raw = @file_get_contents($path);
    if ($raw === false) return null;
    $meta = json_decode($raw, true);
    return is_array($meta) ? $meta : null;
}

function save_meta(string $code, array $meta): void
{
    $tmp = SESSIONS_DIR . "/tmpmeta_{$code}.tmp";
    @file_put_contents($tmp, json_encode($meta));
    @rename($tmp, meta_path($code)); // écriture atomique
}

function tech_present(string $code): bool
{
    $path = presence_path($code);
    if (!is_file($path)) return false;
    return (time() - (int) @file_get_contents($path)) < 15;
}

/**
 * La personne aidée interroge le serveur en continu pendant un partage (1 à
 * 4 s, la cadence des images). Si plus aucun appel ne nous parvient pendant
 * 'client_gone_ms', sa fenêtre a été fermée ou son navigateur est tombé :
 * on termine la session plutôt que de laisser une image en place.
 */
function client_gone(array $meta): bool
{
    global $CONFIG;
    $seen = (int) ($meta['clientSeen'] ?? $meta['created'] ?? 0);
    return $seen > 0 && (now_ms() - $seen) > (int) $CONFIG['client_gone_ms'];
}

function rate_limited(string $kind, int $max, int $window_ms): bool{
    $path = DATA_DIR . '/rl_' . $kind . '_' . md5(client_ip()) . '.json';
    $times = [];
    if (is_file($path)) {
        $decoded = json_decode((string) @file_get_contents($path), true);
        if (is_array($decoded)) $times = $decoded;
    }
    $now = now_ms();
    $cut = $now - $window_ms;
    $times = array_values(array_filter($times, function ($t) use ($cut) {
        return $t > $cut;
    }));
    $times[] = $now;
    @file_put_contents($path, json_encode($times));
    return count($times) > $max;
}

/**
 * Valide une clé publique ECDH P-256 (point non compressé, 65 octets, préfixe 0x04).
 * Renvoie la clé en base64 standard, ou '' si elle est absente/invalide.
 */
function valid_pubkey(string $b64): string
{
    if ($b64 === '' || strlen($b64) > 256) return '';
    $raw = base64_decode(strtr($b64, '-_', '+/'), true);
    if ($raw === false || strlen($raw) !== 65 || $raw[0] !== "\x04") return '';
    return base64_encode($raw);
}

function cleanup_sessions(): int
{
    global $CONFIG;
    $deleted = 0;
    if (!is_dir(SESSIONS_DIR)) return 0;
    $now = now_ms();
    foreach (glob(SESSIONS_DIR . '/meta_*.json') ?: [] as $path) {
        $meta = json_decode((string) @file_get_contents($path), true);
        if (!is_array($meta) || empty($meta['code'])) {
            @unlink($path);
            $deleted++;
            continue;
        }
        $expired = ($now - (int) $meta['created'] > $CONFIG['session_max_ms'])
            || ($now - (int) $meta['lastFrameAt'] > $CONFIG['session_idle_ms'])
            || (!empty($meta['ended']))
            || client_gone($meta);
        if ($expired || !empty($meta['ended'])) {
            $code = $meta['code'];
            // Le motif « disparition » est posé avant l'effacement, pour que la
            // raison soit lisible par le technicien si la session est encore
            // ouverte (le contrôle périodique n'est qu'un filet de sécurité).
            if (client_gone($meta)) end_session($code, 'client-gone', $meta);
            @unlink($path);
            @unlink(frame_path($code));
            @unlink(frame_path_legacy($code));
            @unlink(presence_path($code));
            @unlink(SESSIONS_DIR . "/tmpmeta_{$code}.tmp");
            @unlink(SESSIONS_DIR . "/tmpframe_{$code}.tmp");
            $deleted++;
        }
    }
    // Compteurs anti-abus de plus d'une heure
    foreach (glob(DATA_DIR . '/rl_*.json') ?: [] as $path) {
        if (time() - (int) @filemtime($path) > 3600) @unlink($path);
    }
    return $deleted;
}

function maybe_cleanup(): void
{
    $gate = DATA_DIR . '/last_cleanup.txt';
    $last = is_file($gate) ? (int) @file_get_contents($gate) : 0;
    if (time() - $last < 60) return;
    @file_put_contents($gate, (string) time());
    cleanup_sessions();
}
