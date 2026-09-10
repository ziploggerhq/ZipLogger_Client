<?php

declare(strict_types=1);

namespace ZipLogger\Monolog;

use DateTimeInterface;
use Monolog\Handler\AbstractProcessingHandler;
use ZipLogger\Client;
use ZipLogger\Fields;

// Monolog is a suggestion, not a requirement: fail with a message that says what to install
// instead of "Class Monolog\Handler\AbstractProcessingHandler not found" from the autoloader.
// The throw runs before the class declaration below, so the class is simply never declared.
if (!class_exists(AbstractProcessingHandler::class)) {
    throw new \LogicException(
        'ZipLogger\Monolog\ZipLoggerHandler requires monolog/monolog (^2.0 || ^3.0). '
        . 'Run: composer require monolog/monolog'
    );
}

/**
 * Monolog handler for ZipLogger. Works with Monolog 2 (array records) and Monolog 3 (LogRecord).
 *
 *   $logger = new Monolog\Logger('app');
 *   $logger->pushHandler(new ZipLoggerHandler('https://app.ziplogger.ai', 'zk_...'));
 *
 *   $logger->info('Order created', ['orderId' => 83112]);      // context -> fields
 *   $logger->error('Payment failed', ['exception' => $e]);      // -> stackTrace
 *
 * The channel name becomes `fields.category`; `context` and `extra` become fields (scalars kept,
 * anything else JSON-encoded); a Throwable under `context['exception']` becomes `stackTrace`
 * plus `fields.exceptionType` / `fields.exceptionMessage`.
 */
final class ZipLoggerHandler extends AbstractProcessingHandler
{
    private readonly Client $client;

    /**
     * Three ways to construct, so it fits Laravel's `with` array, Symfony service definitions and
     * plain PHP alike:
     *
     *   new ZipLoggerHandler($client)                                   // share a Client
     *   new ZipLoggerHandler(['endpoint' => ..., 'apiKey' => ...])      // Client options array
     *   new ZipLoggerHandler('https://app.ziplogger.ai', 'zk_...', ['source' => 'web'])
     *
     * @param Client|array<string, mixed>|string $endpoint a Client, a Client options array, or the server origin
     * @param array<string, mixed> $options further Client options when $endpoint is a string or an array
     * @param int|string|object $level Monolog level threshold: an int (100..600), a name, or a
     *        Monolog 3 `Level`. Typed as `object` rather than `Monolog\Level` so this file never
     *        needs a class that does not exist under Monolog 2. Defaults to 100 (debug).
     */
    public function __construct(
        Client|array|string $endpoint,
        ?string $apiKey = null,
        array $options = [],
        int|string|object $level = 100,
        bool $bubble = true,
    ) {
        parent::__construct($level, $bubble);

        if ($endpoint instanceof Client) {
            $this->client = $endpoint;
        } elseif (is_array($endpoint)) {
            $this->client = new Client($endpoint + $options);
        } else {
            $this->client = new Client(['endpoint' => $endpoint, 'apiKey' => $apiKey] + $options);
        }
    }

    public function getClient(): Client
    {
        return $this->client;
    }

    /** Send what is buffered now, for example at the end of a queue job. */
    public function flush(): void
    {
        $this->client->flush();
    }

    /**
     * Monolog calls close() when the Logger is closed or destroyed, which flushes the buffer and
     * stops the client accepting entries. Between queue jobs call flush() instead. The client's
     * own shutdown hook covers the case where nothing ever calls either.
     */
    public function close(): void
    {
        $this->client->close();
        parent::close();
    }

    /**
     * Monolog 2 declares `write(array $record)`, Monolog 3 `write(LogRecord $record)`. An untyped
     * parameter is wider than both, which is what lets one class satisfy either parent.
     *
     * @param \Monolog\LogRecord|array<string, mixed> $record
     */
    protected function write($record): void
    {
        if (is_array($record)) {
            $channel = $record['channel'] ?? null;
            $message = $record['message'] ?? '';
            $context = $record['context'] ?? [];
            $extra = $record['extra'] ?? [];
            $datetime = $record['datetime'] ?? null;
            // Monolog 2 records carry both; level_name is the friendlier one to map.
            $level = $record['level_name'] ?? ($record['level'] ?? 'info');
        } else {
            $channel = $record->channel;
            $message = $record->message;
            $context = $record->context;
            $extra = $record->extra;
            $datetime = $record->datetime;
            // Monolog 3: Level is an enum whose ->value is the same 100..600 scale.
            $level = $record->level->value;
        }

        $fields = [];
        if (is_string($channel) && $channel !== '') {
            $fields['category'] = $channel;
        }

        [$fields, $exception] = Fields::fromContext(is_array($context) ? $context : [], $fields);
        foreach (is_array($extra) ? $extra : [] as $key => $value) {
            // Processors write here (memory usage, request id, ...). Context wins on a name clash,
            // including when the context value is null, which is why this is not `??=`.
            $key = (string) $key;
            if (!array_key_exists($key, $fields)) {
                $fields[$key] = Fields::normalize($value);
            }
        }

        $this->client->log(
            Client::mapLevel(is_int($level) || is_string($level) ? $level : 'info'),
            is_string($message) || $message instanceof \Stringable ? (string) $message : '',
            $fields,
            $exception,
            $datetime instanceof DateTimeInterface ? $datetime : null,
        );
    }
}
