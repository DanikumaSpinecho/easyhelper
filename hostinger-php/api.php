<?php
/**
 * spinecho-support — API du relais de partage d'écran « vue seule »
 * Variante hébergement mutualisé (Hostinger) : PHP pur, sans Node.js ni WebSocket.
 *
 * Actions (paramètre ?action=…) :
 *   create   POST   crée une session (personne aidée)          → {code, token}
 *   upload   POST   envoie une image JPEG (en-têtes X-Code/X-Token)
 *   stop     POST   termine la session (en-têtes X-Code/X-Token)
 *   login    POST   connexion technicien (JSON {password})
 *   logout   POST   déconnexion technicien
 *   me       GET    état d'authentification du technicien       → {ok}
 *   join     POST   vérifie un code de session (technicien authentifié)
 *   fetch    GET    récupère la dernière image (long-polling, technicien authentifié)
 *   selftest GET    diagnostic d'installation (aucune donnée sensible)
 */

declare(strict_types=1);
require __DIR__ . '/inc.php';

function auth_start(): void
{
    ini_set('session.use_strict_mode', '1');
    session_name('SPINESID');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Strict',
        'secure' => is_https(),
    ]);
    session_start();
}

function is_authed(): bool
{
    return !empty($_SESSION['authed']) && (time() - (int) ($_SESSION['auth_time'] ?? 0)) < 43200;
}

function read_json_body(): ?array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') return null;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

$action = (string) ($_GET['action'] ?? '');

switch ($action) {

    // ------------------------------------------------------------------
    // Personne aidée (partage)
    // ------------------------------------------------------------------

    case 'create':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_out(405, ['error' => 'method-not-allowed']);
        maybe_cleanup();
        $ip = client_ip();
        if (rate_limited('create', $CONFIG['create_max_per_min'], 60000)) {
            json_out(429, ['error' => 'rate-limited']);
        }
        $total = 0;
        $activeForIp = 0;
        foreach (glob(SESSIONS_DIR . '/meta_*.json') ?: [] as $path) {
            $meta = json_decode((string) @file_get_contents($path), true);
            if (!is_array($meta) || !empty($meta['ended'])) continue;
            $total++;
            if (($meta['ip'] ?? '') === $ip) $activeForIp++;
        }
        if ($total >= $CONFIG['max_sessions']) json_out(429, ['error' => 'busy']);
        if ($activeForIp >= $CONFIG['max_sessions_per_ip']) json_out(429, ['error' => 'too-many-sessions']);
        do {
            $code = (string) random_int(100000, 999999);
        } while (is_file(meta_path($code)));
        $token = bin2hex(random_bytes(32));
        $meta = [
            'code' => $code,
            'tokenHash' => hash('sha256', $token),
            'ip' => $ip,
            'created' => now_ms(),
            // La limite de cadence s'applique entre deux images : la première est toujours acceptée.
            'lastFrameAt' => now_ms() - $CONFIG['frame_min_interval_ms'],
            'frameId' => 0,
        ];
        save_meta($code, $meta);
        json_out(200, [
            'code' => $code,
            'token' => $token,
            'sessionMaxMs' => $CONFIG['session_max_ms'],
            'sessionIdleMs' => $CONFIG['session_idle_ms'],
        ]);
        break;

    case 'upload':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_out(405, ['error' => 'method-not-allowed']);
        maybe_cleanup();
        $code = valid_code((string) ($_SERVER['HTTP_X_CODE'] ?? ''));
        $token = (string) ($_SERVER['HTTP_X_TOKEN'] ?? '');
        $meta = $code !== '' ? load_meta($code) : null;
        if ($meta === null || !hash_equals($meta['tokenHash'], hash('sha256', $token))) {
            json_out(401, ['error' => 'unauthorized']);
        }
        if (!empty($meta['ended'])) {
            json_out(200, ['state' => 'ended', 'reason' => $meta['ended']]);
        }
        $now = now_ms();
        if ($now - (int) $meta['lastFrameAt'] < $CONFIG['frame_min_interval_ms']) {
            json_out(429, ['error' => 'rate-limited']);
        }
        $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($length <= 0 || $length > $CONFIG['max_frame_bytes']) {
            json_out(413, ['error' => 'frame-too-large']);
        }
        $body = file_get_contents('php://input');
        if ($body === false || strlen($body) > $CONFIG['max_frame_bytes']) {
            json_out(413, ['error' => 'frame-too-large']);
        }
        $tmp = SESSIONS_DIR . "/tmpframe_{$code}.tmp";
        @file_put_contents($tmp, $body);
        @rename($tmp, frame_path($code)); // écriture atomique : le lecteur ne voit jamais d'image tronquée
        $meta['frameId'] = (int) $meta['frameId'] + 1;
        $meta['lastFrameAt'] = $now;
        save_meta($code, $meta);
        json_out(200, [
            'frameId' => $meta['frameId'],
            'tech_present' => tech_present($code),
        ]);
        break;

    case 'stop':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_out(405, ['error' => 'method-not-allowed']);
        $code = valid_code((string) ($_SERVER['HTTP_X_CODE'] ?? ''));
        $token = (string) ($_SERVER['HTTP_X_TOKEN'] ?? '');
        $meta = $code !== '' ? load_meta($code) : null;
        if ($meta === null || !hash_equals($meta['tokenHash'], hash('sha256', $token))) {
            json_out(401, ['error' => 'unauthorized']);
        }
        if (empty($meta['ended'])) {
            $meta['ended'] = 'user-stopped';
            save_meta($code, $meta);
        }
        json_out(200, ['ok' => true]);
        break;

    // ------------------------------------------------------------------
    // Technicien (consultation)
    // ------------------------------------------------------------------

    case 'login':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_out(405, ['error' => 'method-not-allowed']);
        auth_start();
        if (rate_limited('login', $CONFIG['login_max_attempts'], $CONFIG['login_window_ms'])) {
            json_out(429, ['error' => 'rate-limited']);
        }
        if ($CONFIG['tech_password'] === '' && $CONFIG['tech_password_hash'] === '') {
            json_out(503, ['error' => 'not-configured']);
        }
        $body = read_json_body();
        $password = is_array($body) ? (string) ($body['password'] ?? '') : '';
        $ok = false;
        if ($CONFIG['tech_password_hash'] !== '') {
            $ok = password_verify($password, $CONFIG['tech_password_hash']);
        } elseif ($password !== '') {
            $ok = hash_equals((string) $CONFIG['tech_password'], $password);
        }
        if (!$ok) json_out(401, ['error' => 'bad-credentials']);
        session_regenerate_id(true);
        $_SESSION['authed'] = true;
        $_SESSION['auth_time'] = time();
        json_out(200, ['ok' => true]);
        break;

    case 'logout':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_out(405, ['error' => 'method-not-allowed']);
        auth_start();
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
        }
        session_destroy();
        json_out(200, ['ok' => true]);
        break;

    case 'me':
        auth_start();
        json_out(200, ['ok' => is_authed()]);
        break;

    case 'join':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_out(405, ['error' => 'method-not-allowed']);
        auth_start();
        if (!is_authed()) json_out(401, ['error' => 'auth-required']);
        if (rate_limited('join', $CONFIG['join_max_per_min'], 60000)) {
            json_out(429, ['error' => 'rate-limited']);
        }
        $body = read_json_body();
        $code = valid_code((string) (is_array($body) ? ($body['code'] ?? '') : ''));
        if ($code === '') json_out(400, ['error' => 'bad-code']);
        $meta = load_meta($code);
        if ($meta === null || !empty($meta['ended'])) json_out(404, ['error' => 'unknown-code']);
        json_out(200, ['ok' => true]);
        break;

    case 'fetch':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') json_out(405, ['error' => 'method-not-allowed']);
        auth_start();
        if (!is_authed()) json_out(401, ['error' => 'auth-required']);
        $code = valid_code((string) ($_GET['code'] ?? ''));
        if ($code === '') json_out(400, ['error' => 'bad-code']);
        $after = max(0, (int) ($_GET['after'] ?? 0));
        $meta = load_meta($code);
        if ($meta === null) json_out(404, ['error' => 'unknown-code']);
        if (!empty($meta['ended'])) json_out(200, ['state' => 'ended', 'reason' => $meta['ended']]);
        session_write_close(); // libère le verrou de session avant l'attente

        $waitMs = max(500, (int) $CONFIG['fetch_wait_ms']);
        $deadline = microtime(true) + $waitMs / 1000;
        $current = $meta;
        while (microtime(true) < $deadline) {
            $current = load_meta($code);
            if ($current === null) json_out(200, ['state' => 'ended', 'reason' => 'unknown']);
            if (!empty($current['ended'])) json_out(200, ['state' => 'ended', 'reason' => $current['ended']]);
            if ((int) $current['frameId'] > $after) break;
            usleep(200000);
        }
        if ((int) ($current['frameId'] ?? 0) > $after) {
            $frameFile = frame_path($code);
            if (is_file($frameFile)) {
                @file_put_contents(presence_path($code), (string) time());
                $size = (int) @filesize($frameFile);
                header('Content-Type: image/jpeg');
                header('Cache-Control: no-store');
                header('X-Content-Type-Options: nosniff');
                header('X-Frame-Id: ' . (int) $current['frameId']);
                header('X-State: live');
                if ($size > 0) header('Content-Length: ' . $size);
                readfile($frameFile);
                exit;
            }
        }
        http_response_code(204);
        exit;
        break;

    case 'selftest':
        $writable = false;
        $probe = SESSIONS_DIR . '/probe.txt';
        if (@file_put_contents($probe, 'ok') !== false) {
            $writable = true;
            @unlink($probe);
        }
        json_out(200, [
            'ok' => true,
            'php' => PHP_VERSION,
            'config_loaded' => is_file(APP_DIR . '/config.php'),
            'password_configured' => $CONFIG['tech_password'] !== '' || $CONFIG['tech_password_hash'] !== '',
            'data_writable' => is_dir(SESSIONS_DIR) && $writable,
            'https' => is_https(),
            'sessions' => count(glob(SESSIONS_DIR . '/meta_*.json') ?: []),
        ]);
        break;

    default:
        json_out(404, ['error' => 'not-found']);
}
