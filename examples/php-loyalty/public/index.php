<?php

/**
 * Northwind Coffee — loyalty service (PHP).
 *
 * Run:  ZIPLOGGER_API_KEY=zk_... php -S 0.0.0.0:8080 public/index.php
 *
 * A plain-PHP HTTP service using Monolog as the application logger and shipping every record to
 * ZipLogger through the `ziplogger/ziplogger` Monolog handler, which is how most PHP applications
 * will adopt it: no logging calls change, one handler is added.
 *
 * Each request is its own PHP run, exactly as under PHP-FPM. The handler buffers the request's
 * records and the client's shutdown function ships them once the request has finished, so the
 * response is never held up by the network call.
 *
 * Routes:
 *   GET  /health
 *   GET  /loyalty/{customerId}          balance, tier, spend needed for the next tier
 *   POST /loyalty/{customerId}/earn     body {"amount": 12.50}
 */

declare(strict_types=1);

use Monolog\Handler\StreamHandler;
use Monolog\Level;
use Monolog\Logger;
use Northwind\Loyalty\Accounts;
use Northwind\Loyalty\Loyalty;
use ZipLogger\Monolog\ZipLoggerHandler;

require dirname(__DIR__) . '/vendor/autoload.php';

$apiKey = getenv('ZIPLOGGER_API_KEY') ?: '';
if ($apiKey === '') {
    http_response_code(500);
    echo "ZIPLOGGER_API_KEY is required\n";
    exit;
}

$log = new Logger('loyalty');
$log->pushHandler(new StreamHandler('php://stderr', Level::Info));
$log->pushHandler(new ZipLoggerHandler(
    getenv('ZIPLOGGER_ENDPOINT') ?: 'https://app.ziplogger.ai',
    $apiKey,
    [
        'source' => 'loyalty',
        'environment' => getenv('ZIPLOGGER_ENVIRONMENT') ?: 'production',
        'tags' => ['demo', 'php'],
    ],
));

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$started = microtime(true);

$respond = static function (int $status, array $body): void {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body, JSON_UNESCAPED_SLASHES), "\n";
};

try {
    if ($path === '/health') {
        $respond(200, ['status' => 'ok']);

        return;
    }

    if ($method === 'GET' && preg_match('~^/loyalty/([A-Za-z0-9-]+)$~', $path, $m)) {
        $customerId = $m[1];
        $points = Accounts::points($customerId);

        // Guests have zero points per dollar, and summary() divides by it. See Loyalty::spendToNextTier().
        $summary = Loyalty::summary($customerId, $points);

        $durationMs = round((microtime(true) - $started) * 1000, 1);
        $log->info('Loyalty balance served', [
            'customerId' => $customerId,
            'customerName' => Accounts::name($customerId),
            'tier' => $summary['tier'],
            'points' => $points,
            'spendToNextTier' => $summary['spendToNextTier'],
            'durationMs' => $durationMs,
        ]);
        if ($summary['tier'] === 'Gold') {
            $log->notice('Gold member checked in', ['customerId' => $customerId, 'points' => $points]);
        }
        $respond(200, $summary);

        return;
    }

    if ($method === 'POST' && preg_match('~^/loyalty/([A-Za-z0-9-]+)/earn$~', $path, $m)) {
        $customerId = $m[1];
        $input = json_decode((string) file_get_contents('php://input'), true);
        $amount = is_array($input) && isset($input['amount']) ? (float) $input['amount'] : 0.0;
        if ($amount <= 0) {
            $log->warning('Earn request rejected', ['customerId' => $customerId, 'amount' => $amount, 'reason' => 'non-positive amount']);
            $respond(422, ['error' => 'amount must be positive']);

            return;
        }

        $points = Accounts::points($customerId);
        $tier = Loyalty::tierFor($points);
        $earned = Loyalty::pointsEarned($amount, $tier);
        $log->info('Points earned', [
            'customerId' => $customerId,
            'tier' => $tier['name'],
            'amount' => $amount,
            'pointsEarned' => $earned,
            'newBalance' => $points + $earned,
        ]);
        if ($amount > 60) {
            $log->warning('Large purchase flagged for review', ['customerId' => $customerId, 'amount' => $amount]);
        }
        $respond(200, ['customerId' => $customerId, 'pointsEarned' => $earned, 'balance' => $points + $earned]);

        return;
    }

    $log->warning('Route not found', ['method' => $method, 'path' => $path]);
    $respond(404, ['error' => 'not found']);
} catch (Throwable $e) {
    // `exception` is the PSR-3 key for a Throwable; the handler turns it into ZipLogger's
    // stackTrace plus exceptionType / exceptionMessage, which is what drives "which commit broke this?".
    $log->error('Loyalty request failed', [
        'exception' => $e,
        'method' => $method,
        'path' => $path,
        'durationMs' => round((microtime(true) - $started) * 1000, 1),
    ]);
    $respond(500, ['error' => 'internal error']);
}
