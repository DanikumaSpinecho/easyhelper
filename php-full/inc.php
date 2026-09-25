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
    // Entrées conservées dans le journal des connexions (data/access.jsonl).
    // Au-delà, les plus anciennes sont retirées. Les adresses y sont toujours
    // offusquées (dernier octet masqué).
    'max_access_log' => 200,
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

/**
 * Offusque une adresse IP : la trace sert à distinguer des provenances, pas à
 * identifier une personne. On masque donc la fin de l'adresse (dernier octet
 * en IPv4, identité d'interface en IPv6) AVANT de l'écrire : le journal ne
 * contient jamais une adresse complète.
 */
function mask_ip(string $ip): string
{
    if ($ip === '' || strcasecmp($ip, 'unknown') === 0) return 'inconnue';
    $bin = @inet_pton($ip);
    if ($bin === false) return 'inconnue';
    // Adresse IPv4 encapsulée en IPv6 (::ffff:192.168.1.45) : traitée en IPv4.
    if (strlen($bin) === 16) {
        $mapped = "\0\0\0\0\0\0\0\0\0\0\xff\xff";
        if (strncmp($bin, $mapped, 12) === 0) $bin = substr($bin, 12);
    }
    if (strlen($bin) === 4) {
        $o = unpack('C4', $bin);
        return $o[1] . '.' . $o[2] . '.' . $o[3] . '.x';
    }
    if (strlen($bin) === 16) {
        // On garde le préfixe réseau (/64) et on masque l'identité d'interface.
        // Chaque groupe est dégraissé de ses zéros de tête : la variante Node.js
        // produit la même forme, les deux journaux restent comparables.
        $groups = str_split(bin2hex($bin), 4);
        $groups = array_map(function ($g) { return ltrim($g, '0') === '' ? '0' : ltrim($g, '0'); }, $groups);
        return implode(':', array_slice($groups, 0, 4)) . ':x:x:x:x';
    }
    return 'inconnue';
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

// ---------------------------------------------------------------------------
// Journal des connexions (traçabilité)
// ---------------------------------------------------------------------------

function access_log_path(): string
{
    return DATA_DIR . '/access.jsonl';
}

/**
 * Journalise l'accès d'un technicien à une session : date, heure, et adresses
 * IP offusquées des deux côtés. Aucune adresse complète n'est écrite.
 *
 * Le journal est borné : au-delà de 'max_access_log', les entrées les plus
 * anciennes sont retirées. Il vit dans data/ (jamais servi par le web) et
 * n'est lisible que par le technicien authentifié. La trace survit au
 * nettoyage des sessions : c'est précisément son objet.
 */
function log_access(string $techIp, string $userIp, string $code): void
{
    global $CONFIG;
    $entry = json_encode([
        't' => now_ms(),
        'tech' => mask_ip($techIp),
        'user' => mask_ip($userIp),
        'code' => valid_code($code) !== '' ? $code : '',
    ]);
    if ($entry === false) return;
    $path = access_log_path();
    $fh = @fopen($path, 'c+');
    if ($fh === false) return; // journal indisponible : jamais d'échec pour l'assistance
    try {
        if (flock($fh, LOCK_EX)) {
            $content = stream_get_contents($fh);
            $lines = ($content === false || trim($content) === '') ? [] : explode("\n", trim($content));
            $lines[] = $entry;
            // Plafond : on conserve les entrées les plus récentes.
            $max = max(1, (int) $CONFIG['max_access_log']);
            if (count($lines) > $max) $lines = array_slice($lines, -$max);
            ftruncate($fh, 0);
            rewind($fh);
            fwrite($fh, implode("\n", $lines) . "\n");
            fflush($fh);
        }
    } finally {
        @flock($fh, LOCK_UN);
        @fclose($fh);
    }
}

/**
 * Renvoie les entrées les plus récentes d'abord, prêtes pour l'affichage.
 */
function read_access_log(int $limit = 200): array
{
    $path = access_log_path();
    if (!is_file($path)) return [];
    $content = @file_get_contents($path);
    if ($content === false || trim($content) === '') return [];
    $lines = array_slice(explode("\n", trim($content)), -max(1, $limit));
    $out = [];
    foreach (array_reverse($lines) as $line) {
        $decoded = json_decode($line, true);
        if (is_array($decoded) && isset($decoded['t'])) $out[] = $decoded;
    }
    return $out;
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
