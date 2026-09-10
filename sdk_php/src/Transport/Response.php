<?php

declare(strict_types=1);

namespace ZipLogger\Transport;

/**
 * Outcome of one HTTP attempt.
 *
 * A transport never throws for network problems; it reports them as `status === 0` with an `error`,
 * so the client treats "could not connect" and "got a 503" through the same retry path.
 */
final class Response
{
    public function __construct(
        /** HTTP status code, or 0 when no response was received (connect failure, timeout). */
        public readonly int $status,
        /** Seconds to wait before retrying, parsed from `Retry-After` when the server sent one. */
        public readonly ?float $retryAfter = null,
        /** Transport-level error message when `status` is 0. */
        public readonly ?string $error = null,
    ) {
    }

    public static function failed(string $error): self
    {
        return new self(0, null, $error);
    }

    public function isSuccess(): bool
    {
        return $this->status >= 200 && $this->status < 300;
    }

    /**
     * 429 (quota / backpressure), 408, 5xx and transport failures are worth another attempt.
     * Anything else 4xx (400 malformed, 401 revoked key) can never succeed by retrying.
     */
    public function isTransient(): bool
    {
        return $this->status === 0 || $this->status === 408 || $this->status === 429 || $this->status >= 500;
    }
}
