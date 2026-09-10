<?php

declare(strict_types=1);

namespace ZipLogger\Tests;

use DateTimeImmutable;
use DateTimeZone;
use InvalidArgumentException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use RuntimeException;
use ZipLogger\Client;
use ZipLogger\Tests\Support\FakeTransport;
use ZipLogger\Transport\Response;

/** Client behaviour through a fake transport: fast, deterministic, no sockets. */
final class ClientTest extends TestCase
{
    private FakeTransport $transport;

    protected function setUp(): void
    {
        $this->transport = new FakeTransport();
    }

    /** @param array<string, mixed> $overrides */
    private function client(array $overrides = []): Client
    {
        return new Client($overrides + [
            'endpoint' => 'http://stub.local',
            'apiKey' => 'zk_test',
            'transport' => $this->transport,
            'retryBaseDelay' => 0.001,
            'retryMaxDelay' => 0.01,
            'registerShutdownFlush' => false,
        ]);
    }

    // ---------------------------------------------------------------- construction

    public function testAppendsIngestPathUnlessEndpointAlreadyEndsWithLogs(): void
    {
        self::assertSame('http://stub.local/ingest/v1/logs', $this->client(['endpoint' => 'http://stub.local/'])->url());
        self::assertSame('http://stub.local/custom/logs', $this->client(['endpoint' => 'http://stub.local/custom/logs'])->url());
    }

    public function testEndpointAndApiKeyAreRequired(): void
    {
        $this->expectException(InvalidArgumentException::class);
        new Client(['endpoint' => 'http://stub.local', 'registerShutdownFlush' => false]);
    }

    public function testUnknownOptionsAreRejectedLoudly(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('flushIntervalMs');
        $this->client(['flushIntervalMs' => 5]);
    }

    public function testNamedArgumentsWorkTheSameAsTheOptionsArray(): void
    {
        $client = new Client(
            endpoint: 'http://stub.local',
            apiKey: 'zk_named',
            source: 'named-source',
            transport: $this->transport,
            registerShutdownFlush: false,
        );
        $client->info('hello');
        $client->flush();

        self::assertSame('zk_named', $this->transport->requests[0]['headers']['X-Api-Key']);
        self::assertSame('named-source', $this->transport->entries()[0]['source']);
    }

    // ---------------------------------------------------------------- entry shape

    public function testEntryShapeAndEnrichment(): void
    {
        $client = $this->client([
            'source' => 'unit-test', 'release' => '1.2.3', 'commitSha' => 'abc1234',
            'environment' => 'staging', 'tags' => ['demo', 'php'],
        ]);
        $client->log('info', 'event 0', ['orderId' => 7, 'nested' => ['a' => 1]]);
        $client->flush();

        self::assertCount(1, $this->transport->requests);
        $request = $this->transport->requests[0];
        self::assertSame('http://stub.local/ingest/v1/logs', $request['url']);
        self::assertSame('application/x-ndjson', $request['headers']['Content-Type']);
        self::assertSame('zk_test', $request['headers']['X-Api-Key']);

        $entry = $request['lines'][0];
        self::assertSame('event 0', $entry['message']);
        self::assertSame('info', $entry['severity']);
        self::assertSame('unit-test', $entry['source']);
        self::assertSame('1.2.3', $entry['release']);
        self::assertSame('abc1234', $entry['commitSha']);
        self::assertSame(['demo', 'php'], $entry['tags']);
        self::assertSame(7, $entry['fields']['orderId']);
        self::assertSame(['a' => 1], $entry['fields']['nested'], 'the core client passes structure through');
        self::assertSame('staging', $entry['fields']['environment']);
        self::assertNotEmpty($entry['fields']['machineName']);
        self::assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/', $entry['timestamp']);
        self::assertArrayNotHasKey('stackTrace', $entry);
    }

    public function testOptionalEnrichmentIsOmittedWhenUnknown(): void
    {
        $saved = [getenv('ZIPLOGGER_RELEASE'), getenv('ZIPLOGGER_COMMIT_SHA'), getenv('GIT_COMMIT'), getenv('COMMIT_SHA')];
        putenv('ZIPLOGGER_RELEASE');
        putenv('ZIPLOGGER_COMMIT_SHA');
        putenv('GIT_COMMIT');
        putenv('COMMIT_SHA');
        try {
            $client = $this->client();
            $client->info('bare');
            $client->flush();
        } finally {
            foreach (['ZIPLOGGER_RELEASE', 'ZIPLOGGER_COMMIT_SHA', 'GIT_COMMIT', 'COMMIT_SHA'] as $i => $name) {
                if ($saved[$i] !== false) {
                    putenv($name . '=' . $saved[$i]);
                }
            }
        }

        $entry = $this->transport->entries()[0];
        self::assertArrayNotHasKey('release', $entry);
        self::assertArrayNotHasKey('commitSha', $entry);
        self::assertArrayNotHasKey('tags', $entry);
    }

    public function testEnvironmentVariableFallbacks(): void
    {
        $names = ['ZIPLOGGER_SOURCE', 'ZIPLOGGER_RELEASE', 'ZIPLOGGER_COMMIT_SHA', 'GIT_COMMIT', 'ZIPLOGGER_ENVIRONMENT', 'APP_ENV'];
        $saved = array_map('getenv', $names);
        putenv('ZIPLOGGER_SOURCE=env-source');
        putenv('ZIPLOGGER_RELEASE=9.9.9');
        putenv('ZIPLOGGER_COMMIT_SHA');
        putenv('GIT_COMMIT=deadbeef');
        putenv('ZIPLOGGER_ENVIRONMENT');
        putenv('APP_ENV=local');
        try {
            $client = $this->client();
            $client->info('from env');
            $client->flush();
        } finally {
            foreach ($names as $i => $name) {
                putenv($saved[$i] === false ? $name : $name . '=' . $saved[$i]);
            }
        }

        $entry = $this->transport->entries()[0];
        self::assertSame('env-source', $entry['source']);
        self::assertSame('9.9.9', $entry['release']);
        self::assertSame('deadbeef', $entry['commitSha']);
        self::assertSame('local', $entry['fields']['environment']);
    }

    public function testThrowableMapsToStackTraceAndExceptionFields(): void
    {
        $client = $this->client();
        try {
            throw new RuntimeException('boom', 0, new \LogicException('root cause'));
        } catch (RuntimeException $e) {
            $client->error('it failed', ['step' => 'charge'], $e);
        }
        $client->flush();

        $entry = $this->transport->entries()[0];
        self::assertSame('error', $entry['severity']);
        self::assertStringStartsWith('RuntimeException: boom in ', $entry['stackTrace']);
        self::assertStringContainsString(basename(__FILE__) . ':', $entry['stackTrace']);
        self::assertStringContainsString('Stack trace:', $entry['stackTrace']);
        self::assertStringContainsString('Caused by: LogicException: root cause', $entry['stackTrace']);
        self::assertSame(RuntimeException::class, $entry['fields']['exceptionType']);
        self::assertSame('boom', $entry['fields']['exceptionMessage']);
        self::assertSame('charge', $entry['fields']['step']);
    }

    public function testPerEntryOverridesAndExplicitTimestamp(): void
    {
        $client = $this->client(['source' => 'default-source']);
        $at = new DateTimeImmutable('2026-01-02 03:04:05.123456', new DateTimeZone('+02:00'));
        $client->log('warn', 'shifted', [], null, $at, [
            'source' => 'other', 'release' => 'r2', 'commitSha' => 'c2', 'stackTrace' => 'manual trace', 'tags' => ['t'],
        ]);
        $client->flush();

        $entry = $this->transport->entries()[0];
        self::assertSame('2026-01-02T01:04:05.123456Z', $entry['timestamp'], 'timestamps are normalised to UTC');
        self::assertSame('other', $entry['source']);
        self::assertSame('r2', $entry['release']);
        self::assertSame('c2', $entry['commitSha']);
        self::assertSame('manual trace', $entry['stackTrace']);
        self::assertSame(['t'], $entry['tags']);
    }

    public function testSeverityAliasesAndConvenienceMethods(): void
    {
        $client = $this->client();
        $client->debug('d');
        $client->info('i');
        $client->warning('w1');
        $client->warn('w2');
        $client->error('e');
        $client->fatal('f');
        $client->log('WARNING', 'alias');
        $client->log('critical', 'alias2');
        $client->log('nonsense', 'unknown');
        $client->flush();

        $severities = array_column($this->transport->entries(), 'severity');
        self::assertSame(['debug', 'info', 'warn', 'warn', 'error', 'fatal', 'warn', 'fatal', 'info'], $severities);
    }

    public function testUnencodableFieldValuesNeverThrow(): void
    {
        $client = $this->client();
        // JSON_PARTIAL_OUTPUT_ON_ERROR substitutes NAN/INF, so this entry ships with the values replaced.
        $client->info('odd values', ['nan' => NAN, 'inf' => INF, 'closure' => static fn () => 1]);
        $client->flush();

        self::assertCount(1, $this->transport->requests);
        self::assertSame(0, $client->dropped());
        self::assertSame('odd values', $this->transport->entries()[0]['message']);
    }

    public function testRecursiveFieldValuesAreAccountedForEitherWay(): void
    {
        // Whether json_encode manages a partial encode or gives up, the entry is either sent or
        // counted as dropped -- never lost silently, and never raised at the caller.
        $client = $this->client();
        $recursive = [];
        $recursive['self'] = &$recursive;
        $client->info('recursive', ['recursive' => $recursive]);
        $client->flush();

        self::assertSame(1, count($this->transport->entries()) + $client->dropped());
    }

    // ---------------------------------------------------------------- batching

    public function testSendsWhenTheBufferReachesBatchSize(): void
    {
        $client = $this->client(['batchSize' => 3, 'flushInterval' => null]);
        for ($i = 0; $i < 7; $i++) {
            $client->info("m$i");
        }
        self::assertCount(2, $this->transport->requests, 'two full batches shipped as they filled');
        self::assertSame(1, $client->pending());

        $client->flush();
        self::assertSame([3, 3, 1], array_map(static fn ($r) => count($r['lines']), $this->transport->requests));
        self::assertSame(0, $client->pending());
    }

    public function testFlushesAtTheNextLogOnceTheOldestEntryIsOlderThanFlushInterval(): void
    {
        $client = $this->client(['flushInterval' => 0.05]);
        $client->info('first');
        self::assertCount(0, $this->transport->requests, 'a lone fresh entry lingers');
        $client->info('second, still fresh');
        self::assertCount(0, $this->transport->requests);

        usleep(70_000);
        $client->info('third, past the linger');

        self::assertCount(1, $this->transport->requests);
        self::assertCount(3, $this->transport->requests[0]['lines'], 'the entry that triggered the flush goes with the batch');
    }

    public function testAutoFlushIntervalSecondsIsAnAliasForFlushInterval(): void
    {
        $client = $this->client(['autoFlushIntervalSeconds' => 0.02]);
        $client->info('first');
        usleep(30_000);
        $client->info('second');
        self::assertCount(1, $this->transport->requests);
    }

    public function testFlushOnEveryLogShipsImmediately(): void
    {
        $client = $this->client(['flushOnEveryLog' => true]);
        $client->info('one');
        $client->info('two');
        self::assertCount(2, $this->transport->requests);
    }

    public function testBufferOverflowDropsAndCountsInsteadOfBlockingOrGrowing(): void
    {
        $client = $this->client(['queueCapacity' => 3, 'flushInterval' => null]);
        $started = microtime(true);
        for ($i = 0; $i < 50; $i++) {
            $client->info("burst $i");
        }
        self::assertLessThan(0.5, microtime(true) - $started, 'log() must not block');
        self::assertSame(47, $client->dropped());
        self::assertSame(3, $client->pending());

        $client->flush();
        self::assertCount(1, $this->transport->requests);
        self::assertSame(['burst 0', 'burst 1', 'burst 2'], array_column($this->transport->entries(), 'message'));
    }

    public function testCloseSendsWhatRemainsAndThenDrops(): void
    {
        $client = $this->client();
        $client->info('before close');
        $client->close();
        self::assertCount(1, $this->transport->requests);

        $client->info('after close');
        self::assertCount(1, $this->transport->requests);
        self::assertSame(1, $client->dropped());
    }

    public function testFlushWithEmptyBufferSendsNothing(): void
    {
        $client = $this->client();
        $client->flush();
        $client->close();
        self::assertCount(0, $this->transport->requests);
    }

    // ---------------------------------------------------------------- retries

    public function testRetriesOn429ThenSucceedsWithoutDropping(): void
    {
        $this->transport->responses = [429, 429, 202];
        $client = $this->client();
        $client->info('retry me');
        $client->flush();

        self::assertCount(3, $this->transport->requests);
        self::assertSame(0, $client->dropped());
        self::assertSame($this->transport->requests[0]['body'], $this->transport->requests[2]['body'], 'the same batch is resent');
    }

    public function testRetriesOn408And5xx(): void
    {
        $this->transport->responses = [408, 503, 202];
        $client = $this->client();
        $client->info('flaky');
        $client->flush();

        self::assertCount(3, $this->transport->requests);
        self::assertSame(0, $client->dropped());
    }

    public function testDropsTheBatchAfterMaxRetries(): void
    {
        $this->transport->responses = [500, 500, 500, 500];
        $client = $this->client(['maxRetries' => 2]);
        $client->info('doomed');
        $client->info('doomed too');
        $client->flush();

        self::assertCount(3, $this->transport->requests, 'initial attempt + 2 retries');
        self::assertSame(2, $client->dropped(), 'every entry of the batch counts');
    }

    public function testNonTransientResponsesDoNotRetry(): void
    {
        foreach ([400, 401, 403, 404, 413] as $status) {
            $transport = new FakeTransport();
            $transport->responses = [$status];
            $client = $this->client(['transport' => $transport]);
            $client->info('bad request');
            $client->flush();

            self::assertCount(1, $transport->requests, "$status must not be retried");
            self::assertSame(1, $client->dropped());
        }
    }

    public function testTransportExceptionsAreTreatedAsTransient(): void
    {
        $this->transport->responses = [new RuntimeException('connection reset'), Response::failed('timeout'), 202];
        $client = $this->client();
        $client->info('survives');
        $client->flush();

        self::assertCount(3, $this->transport->requests);
        self::assertSame(0, $client->dropped());
    }

    public function testRetryAfterIsHonouredButCappedAtRetryMaxDelay(): void
    {
        // The server asks for a wait we cannot afford inside a request; the cap must win.
        $this->transport->responses = [new Response(429, 3600.0), 202];
        $client = $this->client(['retryMaxDelay' => 0.02]);
        $started = microtime(true);
        $client->info('capped');
        $client->flush();

        self::assertLessThan(1.0, microtime(true) - $started);
        self::assertCount(2, $this->transport->requests);
        self::assertSame(0, $client->dropped());
    }

    public function testZeroRetriesMeansOneAttempt(): void
    {
        $this->transport->responses = [500];
        $client = $this->client(['maxRetries' => 0]);
        $client->info('one shot');
        $client->flush();

        self::assertCount(1, $this->transport->requests);
        self::assertSame(1, $client->dropped());
    }

    // ---------------------------------------------------------------- mapLevel

    /** @return iterable<string, array{string|int, string}> */
    public static function levels(): iterable
    {
        yield 'debug' => ['debug', 'debug'];
        yield 'DEBUG' => ['DEBUG', 'debug'];
        yield 'info' => ['info', 'info'];
        yield 'notice' => ['notice', 'info'];
        yield 'warning' => ['warning', 'warn'];
        yield 'warn' => ['warn', 'warn'];
        yield 'error' => ['error', 'error'];
        yield 'critical' => ['critical', 'fatal'];
        yield 'alert' => ['alert', 'fatal'];
        yield 'emergency' => ['emergency', 'fatal'];
        yield 'fatal' => ['fatal', 'fatal'];
        yield 'unknown' => ['nonsense', 'info'];
        yield 'monolog debug' => [100, 'debug'];
        yield 'monolog info' => [200, 'info'];
        yield 'monolog notice' => [250, 'info'];
        yield 'monolog warning' => [300, 'warn'];
        yield 'monolog error' => [400, 'error'];
        yield 'monolog critical' => [500, 'fatal'];
        yield 'monolog alert' => [550, 'fatal'];
        yield 'monolog emergency' => [600, 'fatal'];
        yield 'numeric string' => ['400', 'error'];
    }

    #[DataProvider('levels')]
    public function testMapLevel(string|int $input, string $expected): void
    {
        self::assertSame($expected, Client::mapLevel($input));
    }
}
