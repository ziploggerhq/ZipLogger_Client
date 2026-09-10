# ziplogger (PHP)

PHP SDK for [ZipLogger](https://ziplogger.ai) — a core client, a **Monolog** handler (Laravel,
Symfony) and a **PSR-3** logger. Batching, retry with backoff (429-aware), drop-on-backpressure,
automatic enrichment. PHP 8.1+, `ext-curl`, and `psr/log` as the only dependency.

```bash
composer require ziplogger/ziplogger
```

## Monolog (Laravel, Symfony, anything)

```php
use Monolog\Logger;
use ZipLogger\Monolog\ZipLoggerHandler;

$logger = new Logger('app');
$logger->pushHandler(new ZipLoggerHandler('https://app.ziplogger.ai', 'zk_...', ['source' => 'orders-api']));

$logger->info('Order created', ['orderId' => 83112, 'customer' => 'acme']);   // context -> fields
$logger->error('Payment failed', ['exception' => $e]);                        // -> stackTrace
```

The channel becomes `fields.category`, `context` and `extra` become searchable fields, and a
`Throwable` under `context['exception']` becomes `stackTrace` plus `exceptionType` /
`exceptionMessage`. Monolog 2 and 3 are both supported.

## Laravel

`config/logging.php`:

```php
'channels' => [
    'stack' => ['driver' => 'stack', 'channels' => ['single', 'ziplogger']],

    'ziplogger' => [
        'driver' => 'monolog',
        'level' => env('LOG_LEVEL', 'info'),
        'handler' => ZipLogger\Monolog\ZipLoggerHandler::class,
        'with' => [
            'endpoint' => env('ZIPLOGGER_ENDPOINT', 'https://app.ziplogger.ai'),
            'apiKey' => env('ZIPLOGGER_API_KEY'),
            'options' => ['source' => env('ZIPLOGGER_SOURCE', 'laravel')],
        ],
    ],
],
```

Then `LOG_CHANNEL=stack` and `Log::info('Order created', ['orderId' => 83112])` ships. Laravel's
exception handler logs uncaught exceptions with `['exception' => $e]`, so they arrive with a
stack trace and no extra code.

## Core client (any framework, or none)

```php
use ZipLogger\Client;

$zl = new Client(endpoint: 'https://app.ziplogger.ai', apiKey: 'zk_...', source: 'billing-worker');

$zl->info('job finished', ['jobId' => 42]);
$zl->error('job failed', ['jobId' => 42], $exception);   // Throwable -> stackTrace
$zl->flush();                                             // optional: at shutdown it happens for you
```

`new Client([...])` with an options array works too. A PSR-3 wrapper is included:

```php
$log = new ZipLogger\Psr\Logger($zl, 'orders');
$log->info('Order {orderId} created', ['orderId' => 83112]);
// message "Order 83112 created", fields.orderId = 83112, fields.messageTemplate = "Order {orderId} created"
```

## Behavior

A logging call never throws. Entries buffer in memory (default cap 10,000, drops beyond and counts
in `$client->dropped()`) and ship as NDJSON batches of 100 to `/ingest/v1/logs`.

PHP has no background thread, so a batch is sent **when the buffer reaches `batchSize`**, **when
the oldest entry is older than `flushInterval` at the next log call**, **on `flush()` /
`close()`**, and **at shutdown** via `register_shutdown_function`. Under PHP-FPM the shutdown flush
runs after the response has been handed to the web server when `fastcgi_finish_request()` has been
called — Laravel and Symfony do this — so users never wait on it. Sends use cURL with a 10 s timeout
and a 3 s connect timeout.

Because a send can happen inside a request, retries are capped tighter than in the threaded SDKs:
2 retries, 0.25 s base delay, 2 s ceiling. 429 (honouring `Retry-After`, capped at the ceiling),
408, 5xx and cURL errors retry; 400/401 drop the batch immediately.

Every entry is enriched with `environment` (`ZIPLOGGER_ENVIRONMENT`, `APP_ENV`), `machineName`,
`release` (`ZIPLOGGER_RELEASE`) and `commitSha` (`ZIPLOGGER_COMMIT_SHA`, `GIT_COMMIT`,
`COMMIT_SHA`), the inputs to ZipLogger's git regression detection.

## Options

| Option | Default | Purpose |
|---|---|---|
| `endpoint`, `apiKey` | required | Server origin and ingestion key |
| `source` | script name / `SERVER_NAME` | Service name |
| `release`, `commitSha` | env vars | Build identity, powers regression attribution |
| `environment` | `APP_ENV` or `production` | Deployment environment |
| `tags` | none | Tags added to every entry |
| `queueCapacity` | 10000 | Max buffered entries (drops beyond) |
| `batchSize` | 100 | Entries per request |
| `flushInterval` | 2.0 s | Max age of the oldest buffered entry before the next `log()` ships it (`null` disables) |
| `flushOnEveryLog` | `false` | Send each entry immediately (CLI and queue workers) |
| `maxRetries` | 2 | Retry attempts per batch (sends are synchronous) |
| `retryBaseDelay` / `retryMaxDelay` | 0.25 s / 2 s | Backoff bounds |
| `timeout` / `connectTimeout` | 10 s / 3 s | cURL timeouts |
| `registerShutdownFlush` | `true` | Flush from `register_shutdown_function` |
| `transport` | `CurlTransport` | Any `ZipLogger\Transport\TransportInterface`, e.g. a fake in tests |

Methods: `log()`, `debug()`, `info()`, `warning()` / `warn()`, `error()`, `fatal()`, `flush()`,
`close()`, `dropped()`, `pending()`, and `Client::mapLevel()`.

Full guide, including Symfony, queue workers and WordPress: [docs/php.md](../docs/php.md).

## Test

```bash
composer install
vendor/bin/phpunit          # starts `php -S` on a free port for the end-to-end tests
```
