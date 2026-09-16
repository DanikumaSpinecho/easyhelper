<?php
/**
 * Nettoyage des sessions expirées (cron Hostinger recommandé : toutes les 5 min).
 * CLI  : php cron.php
 * HTTP : cron.php?key=VOTRE_CLE  (si 'cron_key' est défini dans config.php)
 */

declare(strict_types=1);
require __DIR__ . '/inc.php';

$isCli = PHP_SAPI === 'cli';
if (!$isCli) {
    $key = (string) ($_GET['key'] ?? '');
    $allowed = $CONFIG['cron_key'] !== '' && hash_equals($CONFIG['cron_key'], $key);
    if (!$allowed) {
        http_response_code(403);
        echo 'forbidden';
        exit;
    }
}

$deleted = cleanup_sessions();
$msg = 'cleanup: ' . $deleted . ' session(s) purgée(s)';
if ($isCli) {
    echo $msg . PHP_EOL;
} else {
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo $msg;
}
