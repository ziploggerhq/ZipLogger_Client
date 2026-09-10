<?php

declare(strict_types=1);

namespace ZipLogger;

use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;
use InvalidArgumentException;
use Throwable;
use ZipLogger\Transport\CurlTransport;
use ZipLogger\Transport\TransportInterface;

/**
 * ZipLogger PHP SDK: core client.
 *
 * Mirrors the delivery semantics of the other official SDKs:
 *   - log() never throws; formatting, JSON and network failures are counted, not raised;
 *   - bounded in-memory buffer with drop-on-backpressure (counted, never unbounded memory);
 *   - NDJSON batches over HTTP with retry + exponential backoff, honouring 429 Retry-After;
 *   - automatic enrichment: source, release, commit SHA, environment, hostname.
 *
 * What is different, and why:
 *
 * PHP has no background thread in the FPM or CLI request models, so nothing can ship "later"
 * on its own. Entries buffer in memory and a batch is sent synchronously when the buffer reaches
 * `batchSize`, when the oldest buffered entry is older than `flushInterval` at the time of the
 * next log() call, when flush() or close() is called, or at shutdown through
 * register_shutdown_function(). Under PHP-FPM that shutdown flush runs after the response has been
 * handed to the web server when fastcgi_finish_request() was called (Laravel and Symfony do this),
 * so the user is not kept waiting.
 *
 * Because a send can happen inside a request, the retry policy is capped hard: `maxRetries` 2,
 * `retryBaseDelay` 0.25 s, `retryMaxDelay` 2 s (the threaded SDKs use 5 / 0.5 s / 30 s). Worst
 * case a batch costs roughly a second of backoff plus the HTTP timeouts, then it is dropped and
 * counted rather than holding the process hostage.
 */
final class Client
{
    public const SEVERITIES = ['debug', 'info', 'warn', 'error', 'fatal'];

    private const DEFAULTS = [
        'endpoint' => null,
        'apiKey' => null,
        'source' => null,
        'release' => null,
        'commitSha' => null,
        'environment' => null,
        'tags' => null,
        'queueCapacity' => 10_000,
        'batchSize' => 100,
        'flushInterval' => 2.0,
        'maxRetries' => 2,
        'retryBaseDelay' => 0.25,
        'retryMaxDelay' => 2.0,
        'timeout' => 10.0,
        'connectTimeout' => 3.0,
        'flushOnEveryLog' => false,
        'registerShutdownFlush' => true,
        'transport' => null,
    ];

    private const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
        | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR;

    private readonly string $url;
    private readonly string $apiKey;
    private readonly string $source;
    private readonly ?string $release;
    private readonly ?string $commitSha;
    private readonly string $environment;
    private readonly string $machineName;
    /** @var list<string>|null */
    private readonly ?array $tags;
    private readonly int $queueCapacity;
    private readonly int $batchSize;
    /** Max age of the oldest buffered entry before the next log() ships it; null disables. */
    private readonly ?float $flushInterval;
    private readonly int $maxRetries;
    private readonly float $retryBaseDelay;
    private readonly float $retryMaxDelay;
    private readonly bool $flushOnEveryLog;
    private readonly TransportInterface $transport;

    /** @var list<array<string, mixed>> */
    private array $buffer = [];
    /** microtime(true) at which the oldest buffered entry was accepted. */
    private ?float $oldestAt = null;
    private int $dropped = 0;
    private bool $closed = false;

    /**
     * Accepts either an options array (`new Client(['endpoint' => ..., 'apiKey' => ...])`) or
     * named arguments (`new Client(endpoint: ..., apiKey: ...)`). Keys are the parameter names.
     *
     * @param array<string, mixed>|string $endpoint options array, or the server origin
     * @param list<string>|null $tags
     * @param float|null $flushInterval max age (s) of the oldest buffered entry; null/0 disables
     * @param float|null $autoFlushIntervalSeconds alias of $flushInterval, kept because the name
     *        says what it does in a runtime without timers: a flush is only "automatic" at the
     *        next log() call
     */
    public function __construct(
        array|string $endpoint,
        ?string $apiKey = null,
        ?string $source = null,
        ?string $release = null,
        ?string $commitSha = null,
        ?string $environment = null,
        ?array $tags = null,
        int $queueCapacity = 10_000,
        int $batchSize = 100,
        ?float $flushInterval = 2.0,
        int $maxRetries = 2,
        float $retryBaseDelay = 0.25,
        float $retryMaxDelay = 2.0,
        float $timeout = 10.0,
        float $connectTimeout = 3.0,
        bool $flushOnEveryLog = false,
        bool $registerShutdownFlush = true,
        ?TransportInterface $transport = null,
        ?float $autoFlushIntervalSeconds = null,
    ) {
        if (is_array($endpoint)) {
            $options = $endpoint;
            if (array_key_exists('autoFlushIntervalSeconds', $options)) {
                $options['flushInterval'] = $options['autoFlushIntervalSeconds'];
                unset($options['autoFlushIntervalSeconds']);
            }
            $unknown = array_diff_key($options, self::DEFAULTS);
            if ($unknown !== []) {
                throw new InvalidArgumentException(
                    'ZipLogger: unknown option(s): ' . implode(', ', array_keys($unknown))
                    . '. Known: ' . implode(', ', array_keys(self::DEFAULTS))
                );
            }
            $options += self::DEFAULTS;
        } else {
            $options = [
                'endpoint' => $endpoint,
                'apiKey' => $apiKey,
                'source' => $source,
                'release' => $release,
                'commitSha' => $commitSha,
                'environment' => $environment,
                'tags' => $tags,
                'queueCapacity' => $queueCapacity,
                'batchSize' => $batchSize,
                'flushInterval' => $autoFlushIntervalSeconds ?? $flushInterval,
                'maxRetries' => $maxRetries,
                'retryBaseDelay' => $retryBaseDelay,
                'retryMaxDelay' => $retryMaxDelay,
                'timeout' => $timeout,
                'connectTimeout' => $connectTimeout,
                'flushOnEveryLog' => $flushOnEveryLog,
                'registerShutdownFlush' => $registerShutdownFlush,
                'transport' => $transport,
            ];
        }

        $origin = trim((string) ($options['endpoint'] ?? ''));
        if ($origin === '') {
            throw new InvalidArgumentException('ZipLogger: endpoint is required');
        }
        $key = trim((string) ($options['apiKey'] ?? ''));
        if ($key === '') {
            throw new InvalidArgumentException('ZipLogger: apiKey is required');
        }

        $trimmed = rtrim($origin, '/');
        $this->url = preg_match('~/logs$~i', $trimmed) === 1 ? $trimmed : $trimmed . '/ingest/v1/logs';
        $this->apiKey = $key;

        $this->source = self::firstNonEmpty($options['source'], getenv('ZIPLOGGER_SOURCE')) ?? self::defaultSource();
        $this->release = self::firstNonEmpty($options['release'], getenv('ZIPLOGGER_RELEASE'));
        $this->commitSha = self::firstNonEmpty(
            $options['commitSha'],
            getenv('ZIPLOGGER_COMMIT_SHA'),
            getenv('GIT_COMMIT'),
            getenv('COMMIT_SHA'),
        );
        $this->environment = self::firstNonEmpty(
            $options['environment'],
            getenv('ZIPLOGGER_ENVIRONMENT'),
            getenv('APP_ENV'),
            getenv('ENVIRONMENT'),
        ) ?? 'production';
        $host = gethostname();
        $this->machineName = is_string($host) && $host !== '' ? $host : 'unknown';
        $tagList = $options['tags'];
        $this->tags = is_array($tagList) && $tagList !== [] ? array_values(array_map('strval', $tagList)) : null;

        $this->queueCapacity = max(1, (int) $options['queueCapacity']);
        $this->batchSize = max(1, (int) $options['batchSize']);
        $interval = $options['flushInterval'];
        $this->flushInterval = $interval === null || (float) $interval <= 0 ? null : (float) $interval;
        $this->maxRetries = max(0, (int) $options['maxRetries']);
        $this->retryBaseDelay = max(0.0, (float) $options['retryBaseDelay']);
        $this->retryMaxDelay = max($this->retryBaseDelay, (float) $options['retryMaxDelay']);
        $this->flushOnEveryLog = (bool) $options['flushOnEveryLog'];

        $given = $options['transport'];
        if ($given !== null && !$given instanceof TransportInterface) {
            throw new InvalidArgumentException('ZipLogger: transport must implement ' . TransportInterface::class);
        }
        $this->transport = $given ?? new CurlTransport((float) $options['timeout'], (float) $options['connectTimeout']);

        if ($options['registerShutdownFlush']) {
            // The one piece of global state: PHP calls this after the script (or the FPM request)
            // finishes, which is the only "later" a PHP process has. Holding $this here keeps the
            // client alive until then, which is the point.
            register_shutdown_function(function (): void {
                $this->flush();
            });
        }
    }

    // ------------------------------------------------------------------ logging

    /**
     * Buffer one entry. Never throws.
     *
     * @param string $severity debug|info|warn|error|fatal (anything else becomes info)
     * @param array<string, mixed> $fields searchable key/values; nested values are sent as JSON
     * @param array<string, mixed> $overrides per-entry `source`, `release`, `commitSha`, `stackTrace`, `tags`
     */
    public function log(
        string $severity,
        string $message,
        array $fields = [],
        ?Throwable $exception = null,
        ?DateTimeInterface $timestamp = null,
        array $overrides = [],
    ): void {
        try {
            if ($this->closed || count($this->buffer) >= $this->queueCapacity) {
                $this->dropped++;

                return;
            }

            $this->buffer[] = $this->toEntry($severity, $message, $fields, $exception, $timestamp, $overrides);
            $now = microtime(true);
            $this->oldestAt ??= $now;

            if (
                $this->flushOnEveryLog
                || count($this->buffer) >= $this->batchSize
                || ($this->flushInterval !== null && $now - $this->oldestAt >= $this->flushInterval)
            ) {
                $this->flush();
            }
        } catch (Throwable) {
            // Logging must never take the application down with it.
            $this->dropped++;
        }
    }

    /** @param array<string, mixed> $fields */
    public function debug(string $message, array $fields = [], ?Throwable $exception = null): void
    {
        $this->log('debug', $message, $fields, $exception);
    }

    /** @param array<string, mixed> $fields */
    public function info(string $message, array $fields = [], ?Throwable $exception = null): void
    {
        $this->log('info', $message, $fields, $exception);
    }

    /** @param array<string, mixed> $fields */
    public function warning(string $message, array $fields = [], ?Throwable $exception = null): void
    {
        $this->log('warn', $message, $fields, $exception);
    }

    /** @param array<string, mixed> $fields */
    public function warn(string $message, array $fields = [], ?Throwable $exception = null): void
    {
        $this->log('warn', $message, $fields, $exception);
    }

    /** @param array<string, mixed> $fields */
    public function error(string $message, array $fields = [], ?Throwable $exception = null): void
    {
        $this->log('error', $message, $fields, $exception);
    }

    /** @param array<string, mixed> $fields */
    public function fatal(string $message, array $fields = [], ?Throwable $exception = null): void
    {
        $this->log('fatal', $message, $fields, $exception);
    }

    // ------------------------------------------------------------------ lifecycle

    /** Send everything buffered, in batches of `batchSize`. Never throws. */
    public function flush(): void
    {
        $batch = [];
        try {
            while ($this->buffer !== []) {
                $batch = array_splice($this->buffer, 0, $this->batchSize);
                $this->send($batch);
            }
        } catch (Throwable) {
            // send() does not throw; this is belt and braces so a bug here still cannot reach the app.
            $this->dropped += count($batch) + count($this->buffer);
            $this->buffer = [];
        } finally {
            $this->oldestAt = null;
        }
    }

    /** Flush and stop accepting entries; later log() calls are counted as dropped. */
    public function close(): void
    {
        $this->flush();
        $this->closed = true;
    }

    /** Entries lost to a full buffer, a non-retryable response, or exhausted retries. */
    public function dropped(): int
    {
        return $this->dropped;
    }

    /** Entries currently buffered and not yet sent. */
    public function pending(): int
    {
        return count($this->buffer);
    }

    /** The resolved ingestion URL, for diagnostics. */
    public function url(): string
    {
        return $this->url;
    }

    // ------------------------------------------------------------------ level mapping

    /**
     * Map PSR-3 / Monolog level names and Monolog numeric levels to ZipLogger severities.
     *
     *   debug -> debug; info, notice -> info; warning -> warn; error -> error;
     *   critical, alert, emergency -> fatal. Numbers use Monolog's scale (100..600).
     */
    public static function mapLevel(string|int $level): string
    {
        if (is_int($level) || (is_string($level) && is_numeric($level))) {
            $value = (int) $level;
            if ($value >= 500) {
                return 'fatal';
            }
            if ($value >= 400) {
                return 'error';
            }
            if ($value >= 300) {
                return 'warn';
            }
            if ($value >= 200) {
                return 'info';
            }

            return 'debug';
        }

        $name = strtolower(trim($level));

        return match ($name) {
            'debug', 'trace', 'verbose' => 'debug',
            'info', 'notice' => 'info',
            'warn', 'warning' => 'warn',
            'error', 'err' => 'error',
            'fatal', 'critical', 'alert', 'emergency', 'emerg', 'crit' => 'fatal',
            default => 'info',
        };
    }

    // ------------------------------------------------------------------ internals

    /**
     * @param array<string, mixed> $fields
     * @param array<string, mixed> $overrides
     * @return array<string, mixed>
     */
    private function toEntry(
        string $severity,
        string $message,
        array $fields,
        ?Throwable $exception,
        ?DateTimeInterface $timestamp,
        array $overrides,
    ): array {
        // Custom fields win over enrichment, as in the Node SDK: a caller who sets `environment`
        // on purpose meant it.
        $fields += ['environment' => $this->environment, 'machineName' => $this->machineName];

        $entry = [
            'timestamp' => self::formatTimestamp($timestamp),
            'severity' => in_array($severity, self::SEVERITIES, true) ? $severity : self::mapLevel($severity),
            'message' => $message,
            'source' => (string) ($overrides['source'] ?? $this->source),
        ];

        $release = $overrides['release'] ?? $this->release;
        if ($release !== null && $release !== '') {
            $entry['release'] = (string) $release;
        }
        $commitSha = $overrides['commitSha'] ?? $this->commitSha;
        if ($commitSha !== null && $commitSha !== '') {
            $entry['commitSha'] = (string) $commitSha;
        }

        $stackTrace = $overrides['stackTrace'] ?? null;
        if ($exception !== null) {
            $stackTrace ??= Fields::stackTrace($exception);
            $fields['exceptionType'] = $exception::class;
            $fields['exceptionMessage'] = $exception->getMessage();
        }
        if (is_string($stackTrace) && $stackTrace !== '') {
            $entry['stackTrace'] = $stackTrace;
        }

        $entry['fields'] = $fields;

        $tags = $overrides['tags'] ?? $this->tags;
        if (is_array($tags) && $tags !== []) {
            $entry['tags'] = array_values(array_map('strval', $tags));
        }

        return $entry;
    }

    /** @param list<array<string, mixed>> $batch */
    private function send(array $batch): void
    {
        $lines = [];
        foreach ($batch as $entry) {
            $json = json_encode($entry, self::JSON_FLAGS);
            if ($json === false) {
                $this->dropped++; // unencodable even with partial output: recursion depth, most likely
                continue;
            }
            $lines[] = $json;
        }
        if ($lines === []) {
            return;
        }
        $body = implode("\n", $lines);
        $headers = ['Content-Type' => 'application/x-ndjson', 'X-Api-Key' => $this->apiKey];

        for ($attempt = 0; ; $attempt++) {
            $retryAfter = null;
            try {
                $response = $this->transport->send($this->url, $headers, $body);
                if ($response->isSuccess()) {
                    return;
                }
                if (!$response->isTransient()) {
                    $this->dropped += count($lines); // 400/401/... — retrying cannot help

                    return;
                }
                $retryAfter = $response->retryAfter;
            } catch (Throwable) {
                // A throwing transport is a network failure as far as we are concerned.
            }

            if ($attempt >= $this->maxRetries) {
                $this->dropped += count($lines);

                return;
            }

            $backoff = min($this->retryBaseDelay * (2 ** $attempt), $this->retryMaxDelay);
            $jitter = 1 + random_int(0, 200) / 1000; // up to +20 %, so retries from a fleet spread out
            // Retry-After wins over our own schedule, but never beyond the ceiling: inside a web
            // request a server asking for "next UTC midnight" cannot be honoured by waiting.
            $delay = min($retryAfter ?? $backoff * $jitter, $this->retryMaxDelay);
            if ($delay > 0) {
                usleep((int) round($delay * 1_000_000));
            }
        }
    }

    private static function formatTimestamp(?DateTimeInterface $timestamp): string
    {
        $utc = new DateTimeZone('UTC');
        $at = $timestamp === null
            ? new DateTimeImmutable('now', $utc)
            : DateTimeImmutable::createFromInterface($timestamp)->setTimezone($utc);

        return $at->format('Y-m-d\TH:i:s.u\Z');
    }

    private static function firstNonEmpty(mixed ...$candidates): ?string
    {
        foreach ($candidates as $candidate) {
            if (is_string($candidate) && trim($candidate) !== '') {
                return trim($candidate);
            }
        }

        return null;
    }

    /**
     * CLI: the entry script's basename without extension. Web: the virtual host name. Both are
     * what an operator would call the thing, which is what `source` is for.
     */
    private static function defaultSource(): string
    {
        $script = $_SERVER['SCRIPT_FILENAME'] ?? ($_SERVER['argv'][0] ?? null);
        if (PHP_SAPI === 'cli' && is_string($script) && $script !== '') {
            $name = pathinfo($script, PATHINFO_FILENAME);
            if ($name !== '') {
                return $name;
            }
        }
        $host = $_SERVER['SERVER_NAME'] ?? null;
        if (is_string($host) && $host !== '') {
            return $host;
        }
        if (is_string($script) && $script !== '') {
            $name = pathinfo($script, PATHINFO_FILENAME);
            if ($name !== '') {
                return $name;
            }
        }

        return 'php';
    }
}
