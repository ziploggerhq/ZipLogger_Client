<?php

declare(strict_types=1);

namespace ZipLogger\Psr;

use Psr\Log\AbstractLogger;
use Stringable;
use ZipLogger\Client;
use ZipLogger\Fields;

/**
 * PSR-3 logger backed by a ZipLogger {@see Client}, for frameworks and libraries that take a
 * `Psr\Log\LoggerInterface` and nothing more.
 *
 *   $log = new ZipLogger\Psr\Logger($client, 'orders');
 *   $log->info('Order {orderId} created for {customer}', ['orderId' => 83112, 'customer' => 'acme']);
 *
 * Sends message "Order 83112 created for acme" with fields orderId=83112, customer="acme" and
 * messageTemplate="Order {orderId} created for {customer}". The template is kept because that is
 * what ZipLogger clusters on: one pattern for every order instead of one pattern per order id.
 * `context['exception']` (a Throwable, as PSR-3 reserves the key for) becomes `stackTrace`.
 *
 * Compatible with psr/log 1, 2 and 3: the method declares no parameter types (wider than every
 * version's interface) and a `void` return (narrower than 1.x's none, equal to 2.x and 3.x).
 *
 * One deliberate departure from the spec: PSR-3 says an unknown level SHOULD raise
 * `InvalidArgumentException`. A ZipLogger logging call never throws, so an unrecognised level
 * becomes `info` instead, matching what the ingestion API does with an unknown severity.
 */
final class Logger extends AbstractLogger
{
    public function __construct(
        private readonly Client $client,
        /** Sent as `fields.category`, the way Monolog channels and Python logger names are. */
        private readonly ?string $channel = null,
    ) {
    }

    public function getClient(): Client
    {
        return $this->client;
    }

    /**
     * @param mixed $level PSR-3 level name (or a Monolog numeric level)
     * @param string|Stringable $message
     * @param array<mixed> $context
     */
    public function log($level, $message, array $context = []): void
    {
        $template = $message instanceof Stringable || is_scalar($message) ? (string) $message : '';
        $text = Fields::interpolate($template, $context);

        $fields = $this->channel !== null && $this->channel !== '' ? ['category' => $this->channel] : [];
        [$fields, $exception] = Fields::fromContext($context, $fields);
        if ($text !== $template) {
            $fields['messageTemplate'] = $template;
        }

        $severity = is_int($level) || is_string($level) ? Client::mapLevel($level) : 'info';
        $this->client->log($severity, $text, $fields, $exception);
    }
}
