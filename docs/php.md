# PHP

A core client, a **Monolog** handler and a **PSR-3** logger. Batching, retry with backoff
(429-aware), drop-on-backpressure, automatic enrichment. PHP 8.1 or newer with `ext-curl`; the
only Composer dependency is `psr/log`.

Because it plugs into Monolog, every Laravel and Symfony application starts shipping by adding one
channel or one handler. You do not instrument call sites.

## Install

```bash
composer require ziplogger/ziplogger
```

Monolog is not pulled in for you (`suggest`, not `require`), because the core client and the PSR-3
logger work without it. Laravel and Symfony already have it.

## Monolog handler

```php
use Monolog\Logger;
use ZipLogger\Monolog\ZipLoggerHandler;

$logger = new Logger('app');
$logger->pushHandler(new ZipLoggerHandler(
    'https://app.ziplogger.ai',
    getenv('ZIPLOGGER_API_KEY'),
    ['source' => 'orders-api'],          // any Client option
));

$logger->info('Order created', ['orderId' => 83112, 'customer' => 'acme']);

try {
    charge($order);
} catch (Throwable $e) {
    $logger->error('Payment failed', ['exception' => $e, 'orderId' => $order->id]);
}
```

- The channel name (`app`) becomes `fields.category`.
- `context` and `extra` become searchable fields. Strings, numbers, booleans and `null` pass
  through untouched; arrays and objects are JSON-encoded so nothing is lost, but send the scalar you
  want to filter or range-query on as its own field.
- A `Throwable` under `context['exception']` — the key PSR-3 reserves for it — becomes
  `stackTrace`, `fields.exceptionType` and `fields.exceptionMessage`. That trace is what feeds git
  regression detection.
- Monolog 2 (array records) and Monolog 3 (`LogRecord`) are both supported by the same class.

The handler accepts a `Client` too, when several handlers or a PSR-3 logger should share one
buffer: `new ZipLoggerHandler($client)`. `$handler->flush()` sends what is buffered now.

## Laravel

Add a channel to `config/logging.php`. Laravel's `monolog` driver resolves `with` plus `level` as
named constructor arguments, which is exactly the handler's signature:

```php
'channels' => [
    'stack' => [
        'driver' => 'stack',
        'channels' => ['single', 'ziplogger'],
    ],

    'ziplogger' => [
        'driver' => 'monolog',
        'level' => env('LOG_LEVEL', 'info'),
        'handler' => ZipLogger\Monolog\ZipLoggerHandler::class,
        'with' => [
            'endpoint' => env('ZIPLOGGER_ENDPOINT', 'https://app.ziplogger.ai'),
            'apiKey' => env('ZIPLOGGER_API_KEY'),
            'options' => [
                'source' => env('ZIPLOGGER_SOURCE', env('APP_NAME', 'laravel')),
                'release' => env('ZIPLOGGER_RELEASE'),
            ],
        ],
    ],
],
```

Set `LOG_CHANNEL=stack` in `.env`. `Log::info('Order created', ['orderId' => 83112])` and every
`Log::` call in the framework and your packages now ship. Laravel's exception handler logs
uncaught exceptions with `['exception' => $e]`, so they arrive with stack traces without any code
of yours.

`APP_ENV` is read as the `environment` fallback, so `local`, `staging` and `production` show up as
facets without configuration. To keep local development quiet, leave `ZIPLOGGER_API_KEY` unset and
gate the channel:

```php
'channels' => ['single', ...(env('ZIPLOGGER_API_KEY') ? ['ziplogger'] : [])],
```

If you would rather build the handler yourself (for example to share a `Client` with a PSR-3
logger), use a `via` factory instead of `handler`:

```php
// config/logging.php
'ziplogger' => ['driver' => 'custom', 'via' => App\Logging\CreateZipLogger::class],

// app/Logging/CreateZipLogger.php
final class CreateZipLogger
{
    public function __invoke(array $config): Monolog\Logger
    {
        $client = app(ZipLogger\Client::class);   // bind it as a singleton in a service provider
        return new Monolog\Logger('laravel', [new ZipLogger\Monolog\ZipLoggerHandler($client)]);
    }
}
```

**Octane and queue workers** keep one process alive across many requests or jobs, so the
per-request shutdown flush never runs between them. See [queue workers](#queue-workers-and-long-running-processes)
below; the short version is to flush the handler after each job or set `flushOnEveryLog` for
workers.

## Symfony

Register the handler as a service and reference it from MonologBundle:

```yaml
# config/services.yaml
services:
    ZipLogger\Monolog\ZipLoggerHandler:
        arguments:
            $endpoint: '%env(default:ziplogger.endpoint:ZIPLOGGER_ENDPOINT)%'
            $apiKey: '%env(ZIPLOGGER_API_KEY)%'
            $options: { source: 'orders-api' }
            $level: 'info'

parameters:
    ziplogger.endpoint: 'https://app.ziplogger.ai'
```

```yaml
# config/packages/monolog.yaml
monolog:
    handlers:
        ziplogger:
            type: service
            id: ZipLogger\Monolog\ZipLoggerHandler
            channels: ['!event']       # skip the event dispatcher's debug chatter
```

Symfony's `HttpKernel` calls `fastcgi_finish_request()` in `Kernel::terminate()`, so the shutdown
flush happens after the response has left. Messenger workers are long-running: add
`flushOnEveryLog: true` to `$options` for the worker's environment, or flush from a
`WorkerMessageHandledEvent` listener.

## PSR-3 logger

For libraries and frameworks that take a `Psr\Log\LoggerInterface` and nothing more:

```php
use ZipLogger\Client;
use ZipLogger\Psr\Logger;

$client = new Client(endpoint: 'https://app.ziplogger.ai', apiKey: 'zk_...', source: 'importer');
$log = new Logger($client, 'importer');   // second argument becomes fields.category

$log->info('Imported {count} rows from {file}', ['count' => 1200, 'file' => 'prices.csv']);
$log->error('Import failed', ['exception' => $e]);
```

`{placeholder}` interpolation follows the PSR-3 spec, and the raw context is kept as fields
(`count = 1200`, `file = "prices.csv"`). The template itself is sent as `fields.messageTemplate`
whenever a substitution happened.

**Why keep the template:** ZipLogger clusters log lines into patterns and counts them. `Imported
1200 rows from prices.csv` and `Imported 8 rows from stock.csv` are two different messages, but one
pattern, and the template is the pattern. Group or alert on `messageTemplate` when you want "how
often does this line fire", and search the interpolated `message` when you want a specific run.
Write `{placeholders}` rather than concatenating values into the string: `"Imported $count rows"`
gives ZipLogger nothing to group on.

## Plain PHP and WordPress

No framework, no Monolog:

```php
require __DIR__ . '/vendor/autoload.php';

$zl = new ZipLogger\Client([
    'endpoint' => 'https://app.ziplogger.ai',
    'apiKey' => getenv('ZIPLOGGER_API_KEY'),
    'source' => 'shop',
]);

set_exception_handler(function (Throwable $e) use ($zl): void {
    $zl->fatal('Uncaught exception', [], $e);
    http_response_code(500);
    echo 'Something went wrong';
});

$zl->info('Cart updated', ['cartId' => $cart->id, 'items' => count($cart->items)]);
```

Nothing else is needed at the end of the request: the client registers a shutdown function that
flushes whatever is buffered.

In a WordPress plugin, create the client once on `plugins_loaded` and hand it around:

```php
add_action('plugins_loaded', function (): void {
    $GLOBALS['ziplogger'] = new ZipLogger\Client([
        'endpoint' => 'https://app.ziplogger.ai',
        'apiKey' => defined('ZIPLOGGER_API_KEY') ? ZIPLOGGER_API_KEY : getenv('ZIPLOGGER_API_KEY'),
        'source' => 'wordpress',
        'release' => get_bloginfo('version'),
    ]);
});
```

WP-Cron and WP-CLI commands are ordinary PHP requests or scripts, so the shutdown flush covers them.

## How delivery works in PHP

The other ZipLogger SDKs ship from a background thread. PHP has none: in PHP-FPM every request is
its own short-lived program, and a CLI script is one linear run. So the client buffers in memory
and sends synchronously at one of four moments:

| Trigger | When |
|---|---|
| Buffer reaches `batchSize` (100) | inside the `log()` call that filled it |
| Oldest buffered entry is older than `flushInterval` (2 s) | inside the next `log()` call after that |
| `flush()` or `close()` | when you call it |
| Shutdown | `register_shutdown_function`, after the script or request finishes |

For a typical web request that logs a handful of lines, none of the first three fire and the whole
request's logs go out as one batch at shutdown. **Under PHP-FPM, that shutdown flush runs after
the response has been sent to the web server** whenever `fastcgi_finish_request()` has been called.
Laravel calls it in `Kernel::terminate()`, Symfony in `HttpKernel::terminate()`, so users of those
frameworks never wait for ZipLogger. Under Apache `mod_php` or the built-in server there is no
equivalent: the send happens before the connection closes, which is why the timeouts are short and
the retry budget is small.

Sends use cURL with a 10 s request timeout and a 3 s connect timeout. Retries are capped at 2 with
a 0.25 s base delay and a 2 s ceiling, where the threaded SDKs use 5 / 0.5 s / 30 s. The reason is
the same: a retry loop in PHP runs inside a request, and 5 retries with 30 s backoff would be a
hung page. Worst case, a batch costs roughly a second of backoff plus the HTTP timeouts, then it is
dropped and counted. `Retry-After` on a `429` is honoured, but capped at `retryMaxDelay`: a server
asking for "next UTC midnight" cannot be obeyed by sleeping inside a request. The batch is dropped,
counted, and the next request tries again.

If your stack has a real event loop (Swoole, RoadRunner, FrankenPHP worker mode, ReactPHP), the
process lives for many requests. Treat it like a queue worker.

## Queue workers and long-running processes

A worker runs for hours and logs a line or two per job. With the defaults, entries wait for the
100th line or for the next `log()` call after 2 s, and nothing ships during a quiet stretch. Two
ways to fix that:

```php
// 1. Ship every line as it happens. One small request per line; fine for a worker doing a few jobs per second.
$zl = new ZipLogger\Client(['endpoint' => ..., 'apiKey' => ..., 'flushOnEveryLog' => true]);

// 2. Keep batching, flush after each job.
$worker->onJobFinished(fn () => $zl->flush());
```

For Laravel Horizon or `queue:work`, flush after every job from a service provider:

```php
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Queue;
use ZipLogger\Monolog\ZipLoggerHandler;

$flush = function (): void {
    foreach (Log::channel('ziplogger')->getHandlers() as $handler) {
        if ($handler instanceof ZipLoggerHandler) {
            $handler->flush();
        }
    }
};
Queue::after($flush);
Queue::failing($flush);
```

Call `flush()`, not `close()`: `close()` also stops the handler's client from accepting entries,
which is right at process exit and wrong between jobs.

A worker killed with `SIGKILL` cannot flush. `SIGTERM` handlers can: call `$zl->close()` before
exiting, the same way you would close a database connection.

## Structured fields

```php
$logger->info('Order created', [
    'orderId' => $order->id,             // int: range queries work
    'total' => (float) $order->total,    // float, not a Money object
    'currency' => $order->currency,
    'items' => $order->items,            // array: arrives as a JSON string
]);
```

Only `string`, `int`, `float`, `bool` and `null` stay typed. `DateTimeInterface` values become
RFC 3339 strings. Everything else is JSON-encoded to a string so it arrives readable, but a JSON
string cannot be range-queried. Pull the numbers you care about into their own fields.

The core client passes nested arrays through as real JSON objects (the ingestion API accepts them);
the Monolog handler and PSR-3 logger flatten to strings, matching the Node transports.

`environment` and `machineName` are added to every entry. A field you set with the same name wins.

## Exceptions

Pass the `Throwable`, not its message:

```php
// Monolog / PSR-3
$logger->error('Payment failed', ['exception' => $e]);

// Core client
$zl->error('Payment failed', ['orderId' => $id], $e);
```

`stackTrace` is built from the class, message, file and line, `getTraceAsString()`, and each
chained `getPrevious()` under `Caused by:`. Regression attribution matches those file and line
references against your commits, which is why `release` and `commitSha` should be set in
production.

`$e->getMessage()` on its own is one string among many; the trace is what lets ZipLogger say which
change introduced the failure.

## Configuration

| Option | Default | Purpose |
|---|---|---|
| `endpoint`, `apiKey` | required | Server origin and ingestion key |
| `source` | CLI script name, else `$_SERVER['SERVER_NAME']` | Service name |
| `release` | `ZIPLOGGER_RELEASE` | Build version |
| `commitSha` | `ZIPLOGGER_COMMIT_SHA`, `GIT_COMMIT`, `COMMIT_SHA` | Commit of the running build |
| `environment` | `ZIPLOGGER_ENVIRONMENT`, `APP_ENV`, `ENVIRONMENT`, else `production` | Deployment environment |
| `tags` | none | Tags added to every entry |
| `queueCapacity` | 10000 | Max buffered entries (drops beyond, counted) |
| `batchSize` | 100 | Entries per request |
| `flushInterval` | 2.0 s | Max age of the oldest buffered entry before the next `log()` ships it; `null` disables. `autoFlushIntervalSeconds` is an accepted alias |
| `flushOnEveryLog` | `false` | Send each entry as it is logged |
| `maxRetries` | 2 | Retry attempts per batch |
| `retryBaseDelay` / `retryMaxDelay` | 0.25 s / 2 s | Backoff bounds (also the cap on `Retry-After`) |
| `timeout` / `connectTimeout` | 10 s / 3 s | cURL request and connect timeouts |
| `registerShutdownFlush` | `true` | Register the shutdown flush |
| `transport` | `CurlTransport` | Any `ZipLogger\Transport\TransportInterface`; inject a fake in your tests |

The constructor takes named arguments or an options array with the same keys; an unknown key throws
`InvalidArgumentException` at construction, as do a missing `endpoint` or `apiKey`.

Methods: `log(severity, message, fields, exception, timestamp, overrides)`, `debug()`, `info()`,
`warning()` / `warn()`, `error()`, `fatal()`, `flush()`, `close()`, `dropped()`, `pending()`,
`url()`, and static `mapLevel()` (PSR-3 and Monolog names and Monolog numeric levels to ZipLogger
severities).

### Environment variables

| Variable | Used for |
|---|---|
| `ZIPLOGGER_SOURCE` | `source` |
| `ZIPLOGGER_RELEASE` | `release` |
| `ZIPLOGGER_COMMIT_SHA`, then `GIT_COMMIT`, then `COMMIT_SHA` | `commitSha` |
| `ZIPLOGGER_ENVIRONMENT`, then `APP_ENV`, then `ENVIRONMENT` | `environment` |

Options passed in code always win. With Docker:

```dockerfile
ENV ZIPLOGGER_SOURCE=orders-api ZIPLOGGER_ENVIRONMENT=production
ARG GIT_COMMIT
ENV ZIPLOGGER_COMMIT_SHA=$GIT_COMMIT
```

Under PHP-FPM, environment variables reach PHP only when `clear_env = no` is set in the pool
configuration, or when they are listed as `env[ZIPLOGGER_API_KEY] = $ZIPLOGGER_API_KEY` there.
Laravel's `.env` file sidesteps this because `env()` reads it directly.

## Severity mapping

| Input | ZipLogger severity |
|---|---|
| `debug`, Monolog 100 | `debug` |
| `info`, `notice`, Monolog 200 and 250 | `info` |
| `warning`, `warn`, Monolog 300 | `warn` |
| `error`, Monolog 400 | `error` |
| `critical`, `alert`, `emergency`, `fatal`, Monolog 500+ | `fatal` |

Anything unrecognised becomes `info`.

## Message templates

Keep one template per call site. Monolog leaves `{placeholders}` in the message unless you add
`PsrLogMessageProcessor`, so this ships the template as the message and the values as fields, which
is the ideal shape for clustering:

```php
$logger->info('Order {orderId} created', ['orderId' => 83112]);   // one pattern for every order
$logger->info("Order $orderId created");                            // one pattern per order: avoid
```

If you do use `PsrLogMessageProcessor`, the interpolated message is what ships. The ZipLogger PSR-3
logger interpolates too, but keeps the template as `fields.messageTemplate` so grouping still works.

## Testing your own code

Inject a fake transport so tests never touch the network:

```php
final class RecordingTransport implements ZipLogger\Transport\TransportInterface
{
    public array $bodies = [];
    public function send(string $url, array $headers, string $body): ZipLogger\Transport\Response
    {
        $this->bodies[] = $body;
        return new ZipLogger\Transport\Response(202);
    }
}

$transport = new RecordingTransport();
$client = new ZipLogger\Client(endpoint: 'http://test', apiKey: 'zk_test', transport: $transport, registerShutdownFlush: false);
```

## Tracing

Use OpenTelemetry's PHP SDK with the OTLP/HTTP exporter pointed at ZipLogger; nothing
ZipLogger-specific is needed:

```bash
composer require open-telemetry/sdk open-telemetry/exporter-otlp
OTEL_EXPORTER_OTLP_ENDPOINT=https://app.ziplogger.ai \
OTEL_EXPORTER_OTLP_HEADERS=X-Api-Key=zk_... \
OTEL_SERVICE_NAME=orders-api \
OTEL_PHP_AUTOLOAD_ENABLED=true php-fpm
```

Add the active trace id to your log fields (`'traceId' => Span::getCurrent()->getContext()->getTraceId()`)
so each line links to its waterfall. See [tracing](tracing.md#correlating-logs-with-traces).

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing arrives from a web app | The key. A `401` drops silently and increments `dropped()`; log it at the end of the request while debugging. |
| Nothing arrives from a worker | Nothing triggers a flush during quiet periods. Set `flushOnEveryLog` or call `flush()` after each job. |
| Nothing arrives from Octane / Swoole / RoadRunner | Long-lived process: same fix as a worker. |
| Requests feel slower | You are not on FPM with `fastcgi_finish_request()`, so the flush runs before the connection closes. Lower `timeout` and `connectTimeout`, or ship via a queue worker. |
| Env vars are empty under FPM | `clear_env = no` in the pool config, or list each variable there. |
| A field arrives as a JSON string | Non-scalars are JSON-encoded. Send the scalar as its own field. |
| `dropped()` climbing | Buffer full or endpoint unreachable. Verify the key, then raise `batchSize`. |
| Every message is its own pattern | String interpolation instead of `{placeholders}`. |
| `LogicException: requires monolog/monolog` | You referenced the Monolog handler without Monolog installed. `composer require monolog/monolog`. |
