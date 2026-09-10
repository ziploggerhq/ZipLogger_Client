<?php

declare(strict_types=1);

namespace ZipLogger\Transport;

/**
 * The single seam between the client and the network.
 *
 * The default is {@see CurlTransport}. Tests (yours included) can substitute a fake that records
 * bodies and scripts status codes without opening a socket.
 */
interface TransportInterface
{
    /**
     * POST one NDJSON batch.
     *
     * @param array<string, string> $headers header name => value
     *
     * Implementations should not throw for network failures; return {@see Response::failed()} instead.
     * The client still guards against exceptions, so a throwing transport is treated as transient.
     */
    public function send(string $url, array $headers, string $body): Response;
}
