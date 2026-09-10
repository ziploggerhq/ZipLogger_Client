<?php

declare(strict_types=1);

namespace ZipLogger\Transport;

use CurlHandle;

/**
 * ext-curl transport. One handle is kept for the lifetime of the transport so consecutive batches
 * within a request (or a long-running worker) reuse the TCP/TLS connection.
 */
final class CurlTransport implements TransportInterface
{
    private ?CurlHandle $handle = null;

    public function __construct(
        /** Whole-request budget in seconds (connect + send + response). */
        private readonly float $timeout = 10.0,
        /** Connect phase budget in seconds. Kept short so an unreachable endpoint fails fast. */
        private readonly float $connectTimeout = 3.0,
    ) {
    }

    public function send(string $url, array $headers, string $body): Response
    {
        if ($this->handle === null) {
            $created = curl_init();
            if ($created === false) {
                return Response::failed('curl_init() failed');
            }
            $this->handle = $created;
        }
        $handle = $this->handle;
        curl_reset($handle);

        $headerLines = [
            // cURL adds "Expect: 100-continue" to POST bodies over 1 KB and then waits up to a
            // second for a 100 that many servers never send. Every batch is over 1 KB.
            'Expect:',
        ];
        foreach ($headers as $name => $value) {
            $headerLines[] = $name . ': ' . $value;
        }

        $retryAfter = null;
        $ok = curl_setopt_array($handle, [
            CURLOPT_URL => $url,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $headerLines,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_TIMEOUT_MS => max(1, (int) round($this->timeout * 1000)),
            CURLOPT_CONNECTTIMEOUT_MS => max(1, (int) round($this->connectTimeout * 1000)),
            // Sub-second timeouts rely on signals unless NOSIGNAL is set; without it cURL rounds the
            // DNS phase up to whole seconds and can deliver SIGALRM into a threaded SAPI.
            CURLOPT_NOSIGNAL => true,
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$retryAfter): int {
                if (stripos($line, 'retry-after:') === 0) {
                    $retryAfter = self::parseRetryAfter(trim(substr($line, 12)));
                }

                return strlen($line);
            },
        ]);
        if (!$ok) {
            return Response::failed('curl_setopt_array() failed: ' . curl_error($handle));
        }

        $result = curl_exec($handle);
        if ($result === false) {
            return Response::failed(curl_error($handle) ?: 'cURL error ' . curl_errno($handle));
        }

        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        if ($status === 0) {
            return Response::failed('no HTTP status in response');
        }

        return new Response($status, $retryAfter);
    }

    /** `Retry-After` is either delta-seconds or an HTTP-date. Both come back as seconds from now. */
    public static function parseRetryAfter(string $value): ?float
    {
        if ($value === '') {
            return null;
        }
        if (is_numeric($value)) {
            return max(0.0, (float) $value);
        }
        $at = strtotime($value);
        if ($at === false) {
            return null;
        }

        return max(0.0, (float) ($at - time()));
    }
}
