<?php

declare(strict_types=1);

namespace ZipLogger;

use DateTimeInterface;
use JsonSerializable;
use Stringable;
use Throwable;

/**
 * Value shaping shared by the Monolog handler and the PSR-3 logger.
 *
 * @internal Not part of the public API; may change without notice.
 */
final class Fields
{
    private const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
        | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR;

    private function __construct()
    {
    }

    /**
     * Scalars and null pass through untouched so numbers stay range-queryable. Everything else is
     * JSON-encoded to a string, so nested arrays and objects arrive readable instead of as
     * "Array" or "[object]". Send the scalar you want to filter on as its own field.
     */
    public static function normalize(mixed $value): string|int|float|bool|null
    {
        if ($value === null || is_scalar($value)) {
            return $value;
        }
        if ($value instanceof DateTimeInterface) {
            return $value->format(DateTimeInterface::RFC3339_EXTENDED);
        }
        if ($value instanceof Throwable) {
            return $value::class . ': ' . $value->getMessage();
        }
        if ($value instanceof Stringable) {
            return (string) $value;
        }
        if (is_resource($value)) {
            return '[resource ' . get_resource_type($value) . ']';
        }
        if (is_object($value) && !$value instanceof JsonSerializable && !$value instanceof \stdClass
            && !$value instanceof \Traversable) {
            $encoded = json_encode(get_object_vars($value), self::JSON_FLAGS);
            if ($encoded !== false && $encoded !== '[]' && $encoded !== '{}') {
                return $encoded;
            }

            return '[object ' . $value::class . ']';
        }
        if ($value instanceof \Traversable) {
            $value = iterator_to_array($value);
        }
        $encoded = json_encode($value, self::JSON_FLAGS);

        return $encoded === false ? '[unserializable]' : $encoded;
    }

    /**
     * Split a PSR-3 style context into ZipLogger fields plus the Throwable found under
     * `context['exception']`, the key the PSR-3 spec reserves for exactly this purpose.
     *
     * @param array<mixed> $context
     * @return array{0: array<string, string|int|float|bool|null>, 1: ?Throwable}
     */
    public static function fromContext(array $context, array $fields = []): array
    {
        $exception = null;
        foreach ($context as $key => $value) {
            if ($key === 'exception' && $value instanceof Throwable) {
                $exception = $value;
                continue;
            }
            $fields[(string) $key] = self::normalize($value);
        }

        return [$fields, $exception];
    }

    /**
     * PSR-3 `{placeholder}` interpolation. Only keys that are valid placeholder names are
     * substituted; values are rendered the way PSR-3 recommends (scalars, Stringable, dates).
     *
     * @param array<mixed> $context
     */
    public static function interpolate(string $message, array $context): string
    {
        if ($context === [] || !str_contains($message, '{')) {
            return $message;
        }
        $replace = [];
        foreach ($context as $key => $value) {
            $key = (string) $key;
            if (!preg_match('/^[A-Za-z0-9_.]+$/', $key) || !str_contains($message, '{' . $key . '}')) {
                continue;
            }
            $replace['{' . $key . '}'] = self::render($value);
        }

        return $replace === [] ? $message : strtr($message, $replace);
    }

    private static function render(mixed $value): string
    {
        if ($value === null) {
            return '';
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        // Throwable extends Stringable since PHP 8, and its __toString() is the whole trace: check it first.
        if ($value instanceof Throwable) {
            return $value::class . ': ' . $value->getMessage();
        }
        if ($value instanceof DateTimeInterface) {
            return $value->format(DateTimeInterface::RFC3339_EXTENDED);
        }
        if (is_scalar($value) || $value instanceof Stringable) {
            return (string) $value;
        }
        if (is_object($value)) {
            return '[object ' . $value::class . ']';
        }
        if (is_array($value)) {
            $encoded = json_encode($value, self::JSON_FLAGS);

            return $encoded === false ? '[array]' : $encoded;
        }

        return '[' . get_debug_type($value) . ']';
    }

    /**
     * The stack trace ZipLogger shows and feeds to regression attribution: type, message, the
     * throwing file:line, the frames, then the same for each chained `previous` exception.
     */
    public static function stackTrace(Throwable $exception): string
    {
        $parts = [];
        $seen = 0;
        for ($current = $exception; $current !== null && $seen < 10; $current = $current->getPrevious(), $seen++) {
            $header = $current::class . ': ' . $current->getMessage()
                . ' in ' . $current->getFile() . ':' . $current->getLine();
            $parts[] = $header . "\nStack trace:\n" . $current->getTraceAsString();
        }

        return implode("\n\nCaused by: ", $parts);
    }
}
