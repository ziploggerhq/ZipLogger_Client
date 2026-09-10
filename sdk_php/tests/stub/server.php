<?php

/**
 * Scriptable ingestion stub for the end-to-end tests, run as a router script under `php -S`:
 *
 *   ZL_STUB_DIR=/tmp/x php -S 127.0.0.1:PORT tests/stub/server.php
 *
 * Every request is appended as one JSON line to `$ZL_STUB_DIR/requests.ndjson`. Status codes are
 * taken from the queue in `$ZL_STUB_DIR/responses.json` (a JSON array of ints), default 202. A 429
 * carries `Retry-After: 0` so the client's honour-the-header path is exercised without waiting.
 *
 * `php -S` is single-threaded, so the file reads and writes below never interleave.
 */

declare(strict_types=1);

$dir = getenv('ZL_STUB_DIR') ?: sys_get_temp_dir();
$requestsFile = $dir . DIRECTORY_SEPARATOR . 'requests.ndjson';
$responsesFile = $dir . DIRECTORY_SEPARATOR . 'responses.json';

$path = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

if ($path === '/__health') {
    http_response_code(200);
    header('Content-Type: text/plain');
    echo 'ok';

    return true;
}

$status = 202;
if (is_file($responsesFile)) {
    $queue = json_decode((string) file_get_contents($responsesFile), true);
    if (is_array($queue) && $queue !== []) {
        $status = (int) array_shift($queue);
        file_put_contents($responsesFile, json_encode(array_values($queue)), LOCK_EX);
    }
}

$body = (string) file_get_contents('php://input');
$lines = [];
foreach (explode("\n", $body) as $line) {
    if (trim($line) !== '') {
        $lines[] = json_decode($line, true);
    }
}

$record = [
    'path' => $path,
    'method' => $_SERVER['REQUEST_METHOD'] ?? null,
    'apiKey' => $_SERVER['HTTP_X_API_KEY'] ?? null,
    'contentType' => $_SERVER['CONTENT_TYPE'] ?? ($_SERVER['HTTP_CONTENT_TYPE'] ?? null),
    'lines' => $lines,
    'status' => $status,
];
file_put_contents($requestsFile, json_encode($record) . "\n", FILE_APPEND | LOCK_EX);

http_response_code($status);
header('Content-Type: application/json');
if ($status === 429) {
    header('Retry-After: 0');
}
echo json_encode([
    'accepted' => $status >= 200 && $status < 300 ? count($lines) : 0,
    'rejected' => $status >= 200 && $status < 300 ? 0 : count($lines),
    'error' => $status >= 400 ? 'scripted ' . $status : null,
]);

return true;
