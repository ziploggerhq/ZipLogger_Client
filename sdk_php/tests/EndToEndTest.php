<?php

declare(strict_types=1);

namespace ZipLogger\Tests;

use PHPUnit\Framework\TestCase;
use ZipLogger\Client;
use ZipLogger\Tests\Support\StubServer;

/** The real CurlTransport against `php -S` running tests/stub/server.php. */
final class EndToEndTest extends TestCase
{
    private static ?StubServer $server = null;

    public static function setUpBeforeClass(): void
    {
        self::$server = new StubServer();
    }

    public static function tearDownAfterClass(): void
    {
        // Guarded: if the server failed to start there is nothing to stop, and hiding that
        // failure behind an Error here would be worse than the original message.
        self::$server?->stop();
        self::$server = null;
    }

    private static function server(): StubServer
    {
        if (self::$server === null) {
            self::fail('stub server is not running');
        }

        return self::$server;
    }

    protected function setUp(): void
    {
        self::server()->reset();
    }

    /** @param array<string, mixed> $overrides */
    private function client(array $overrides = []): Client
    {
        return new Client($overrides + [
            'endpoint' => self::server()->url(),
            'apiKey' => 'zk_test',
            'flushInterval' => null,       // the tests flush explicitly, so timing never matters
            'retryBaseDelay' => 0.01,
            'retryMaxDelay' => 0.05,
            'timeout' => 5.0,
            'connectTimeout' => 2.0,
            'registerShutdownFlush' => false,
        ]);
    }

    public function testBatchesNdjsonWithApiKeyAndEnrichment(): void
    {
        $client = $this->client(['source' => 'unit-test', 'release' => '1.2.3', 'commitSha' => 'abc1234']);
        for ($i = 0; $i < 5; $i++) {
            $client->info("event $i", ['i' => $i]);
        }
        $client->close();

        $requests = self::server()->waitFor(1);
        self::assertCount(1, $requests);
        $request = $requests[0];
        self::assertSame('/ingest/v1/logs', $request['path']);
        self::assertSame('POST', $request['method']);
        self::assertSame('zk_test', $request['apiKey']);
        self::assertSame('application/x-ndjson', $request['contentType']);
        self::assertCount(5, $request['lines']);

        $first = $request['lines'][0];
        self::assertSame('event 0', $first['message']);
        self::assertSame('info', $first['severity']);
        self::assertSame('unit-test', $first['source']);
        self::assertSame('1.2.3', $first['release']);
        self::assertSame('abc1234', $first['commitSha']);
        self::assertSame(0, $first['fields']['i']);
        self::assertNotEmpty($first['fields']['machineName']);
        self::assertNotEmpty($first['fields']['environment']);
        self::assertNotEmpty($first['timestamp']);
    }

    public function testThrowableBecomesStackTraceAndExceptionFields(): void
    {
        $client = $this->client();
        try {
            throw new \TypeError('boom');
        } catch (\TypeError $e) {
            $client->error('it failed', [], $e);
        }
        $client->close();

        $entry = self::server()->waitFor(1)[0]['lines'][0];
        self::assertSame('error', $entry['severity']);
        self::assertStringContainsString('TypeError: boom', $entry['stackTrace']);
        self::assertSame('TypeError', $entry['fields']['exceptionType']);
        self::assertSame('boom', $entry['fields']['exceptionMessage']);
    }

    public function testRetriesOn429WithRetryAfterThenSucceedsWithoutDropping(): void
    {
        self::server()->script([429, 429, 202]);
        $client = $this->client();
        $client->info('retry me');
        $client->flush();

        $requests = self::server()->waitFor(3);
        self::assertSame([429, 429, 202], array_column($requests, 'status'));
        self::assertSame(0, $client->dropped());
        self::assertSame('retry me', $requests[2]['lines'][0]['message']);
    }

    public function testDropsTheBatchAfterMaxRetries(): void
    {
        self::server()->script([500, 500, 500]);
        $client = $this->client(['maxRetries' => 2]);
        $client->info('doomed');
        $client->flush();

        self::assertCount(3, self::server()->waitFor(3));
        self::assertSame(1, $client->dropped());
    }

    public function testNonTransientErrorsDoNotRetry(): void
    {
        self::server()->script([401]);
        $client = $this->client();
        $client->info('bad key');
        $client->flush();

        self::assertCount(1, self::server()->waitFor(1));
        self::assertSame(1, $client->dropped());
    }

    public function testLargeVolumesSplitIntoBatchesOfBatchSize(): void
    {
        $client = $this->client(['batchSize' => 10]);
        for ($i = 0; $i < 25; $i++) {
            $client->info("m$i");
        }
        self::assertCount(2, self::server()->waitFor(2), 'full batches ship as they fill');
        $client->close();

        $sizes = array_map(static fn ($r) => count($r['lines']), self::server()->waitFor(3));
        self::assertSame(25, array_sum($sizes));
        self::assertSame(10, max($sizes));
    }

    public function testLargeBodiesArriveIntact(): void
    {
        // Over cURL's 1 KB "Expect: 100-continue" threshold, and with non-ASCII in the payload.
        $client = $this->client();
        $client->info(str_repeat('ü', 3000), ['blob' => str_repeat('x', 5000)]);
        $client->flush();

        $entry = self::server()->waitFor(1)[0]['lines'][0];
        self::assertSame(str_repeat('ü', 3000), $entry['message']);
        self::assertSame(5000, strlen($entry['fields']['blob']));
        self::assertSame(0, $client->dropped());
    }

    public function testUnreachableEndpointDropsQuicklyInsteadOfHanging(): void
    {
        $client = new Client([
            'endpoint' => 'http://127.0.0.1:9', // discard port, nothing listens
            'apiKey' => 'zk_test',
            'flushInterval' => null,
            'maxRetries' => 1,
            'retryBaseDelay' => 0.01,
            'retryMaxDelay' => 0.05,
            'connectTimeout' => 1.0,
            'timeout' => 2.0,
            'registerShutdownFlush' => false,
        ]);
        $started = microtime(true);
        $client->info('nobody home');
        $client->flush();

        self::assertSame(1, $client->dropped());
        self::assertLessThan(6.0, microtime(true) - $started, 'two connect attempts plus one short backoff');
    }

    public function testStubServerRejectsNothingByDefault(): void
    {
        // Guards the harness itself: a stale scripted queue would make every later test flaky.
        $client = $this->client();
        $client->info('plain');
        $client->flush();
        $requests = self::server()->waitFor(1);
        self::assertSame(202, $requests[0]['status'], 'a stale scripted queue would make every later test flaky');
        self::assertSame(0, $client->dropped());
    }
}
