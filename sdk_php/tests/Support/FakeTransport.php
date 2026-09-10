<?php

declare(strict_types=1);

namespace ZipLogger\Tests\Support;

use Throwable;
use ZipLogger\Transport\Response;
use ZipLogger\Transport\TransportInterface;

/** Records every send and answers from a scripted queue; no sockets, no sleeping on the server side. */
final class FakeTransport implements TransportInterface
{
    /** @var list<array{url: string, headers: array<string, string>, body: string, lines: list<array<string, mixed>>}> */
    public array $requests = [];

    /** @var list<int|Response|Throwable> queued answers; 202 once empty. Ints of 429 carry Retry-After 0. */
    public array $responses = [];

    public function send(string $url, array $headers, string $body): Response
    {
        $lines = [];
        foreach (explode("\n", $body) as $line) {
            if ($line !== '') {
                $lines[] = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
            }
        }
        $this->requests[] = ['url' => $url, 'headers' => $headers, 'body' => $body, 'lines' => $lines];

        $next = array_shift($this->responses);
        if ($next instanceof Throwable) {
            throw $next;
        }
        if ($next instanceof Response) {
            return $next;
        }
        if ($next === null) {
            return new Response(202);
        }

        return new Response($next, $next === 429 ? 0.0 : null);
    }

    /** @return list<array<string, mixed>> every entry across every request, in order */
    public function entries(): array
    {
        if ($this->requests === []) {
            return [];
        }

        return array_merge(...array_map(static fn (array $r): array => $r['lines'], $this->requests));
    }
}
