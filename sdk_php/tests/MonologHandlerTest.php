<?php

declare(strict_types=1);

namespace ZipLogger\Tests;

use DateTimeImmutable;
use DateTimeZone;
use Monolog\Level;
use Monolog\Logger;
use Monolog\LogRecord;
use PHPUnit\Framework\TestCase;
use ZipLogger\Client;
use ZipLogger\Monolog\ZipLoggerHandler;
use ZipLogger\Tests\Support\FakeTransport;

final class MonologHandlerTest extends TestCase
{
    private FakeTransport $transport;

    protected function setUp(): void
    {
        $this->transport = new FakeTransport();
    }

    /** @param array<string, mixed> $options */
    private function handler(array $options = [], int|string|Level $level = Level::Debug): ZipLoggerHandler
    {
        return new ZipLoggerHandler($options + [
            'endpoint' => 'http://stub.local',
            'apiKey' => 'zk_test',
            'transport' => $this->transport,
            'registerShutdownFlush' => false,
            'flushInterval' => null,
        ], level: $level);
    }

    public function testLevelsMapToSeverities(): void
    {
        $handler = $this->handler();
        $logger = new Logger('app', [$handler]);
        $logger->debug('d');
        $logger->info('i');
        $logger->notice('n');
        $logger->warning('w');
        $logger->error('e');
        $logger->critical('c');
        $logger->alert('a');
        $logger->emergency('em');
        $handler->flush();

        self::assertSame(
            ['debug', 'info', 'info', 'warn', 'error', 'fatal', 'fatal', 'fatal'],
            array_column($this->transport->entries(), 'severity'),
        );
    }

    public function testChannelContextAndExtraBecomeFields(): void
    {
        $handler = $this->handler();
        $logger = new Logger('orders', [$handler]);
        $logger->pushProcessor(static function (LogRecord $record): LogRecord {
            $record->extra['requestId'] = 'req-1';
            $record->extra['orderId'] = 'from-extra-should-lose';

            return $record;
        });
        $logger->info('Order created', [
            'orderId' => 83112,
            'total' => 19.5,
            'paid' => true,
            'nothing' => null,
            'items' => ['sku' => 'ETH-YIRG-250', 'qty' => 2],
            'when' => new DateTimeImmutable('2026-01-02T03:04:05Z'),
        ]);
        $handler->flush();

        $entry = $this->transport->entries()[0];
        self::assertSame('Order created', $entry['message']);
        $fields = $entry['fields'];
        self::assertSame('orders', $fields['category']);
        self::assertSame(83112, $fields['orderId'], 'context beats extra on a name clash');
        self::assertSame(19.5, $fields['total']);
        self::assertTrue($fields['paid']);
        self::assertArrayHasKey('nothing', $fields);
        self::assertNull($fields['nothing']);
        self::assertSame('{"sku":"ETH-YIRG-250","qty":2}', $fields['items'], 'non-scalars are JSON-encoded');
        self::assertStringStartsWith('2026-01-02T03:04:05', $fields['when']);
        self::assertSame('req-1', $fields['requestId']);
        self::assertArrayHasKey('environment', $fields);
        self::assertArrayHasKey('machineName', $fields);
    }

    public function testContextExceptionBecomesStackTrace(): void
    {
        $handler = $this->handler();
        $logger = new Logger('payments', [$handler]);
        try {
            throw new \DomainException('card declined');
        } catch (\DomainException $e) {
            $logger->error('Payment failed', ['exception' => $e, 'orderId' => 1]);
        }
        $handler->flush();

        $entry = $this->transport->entries()[0];
        self::assertSame('error', $entry['severity']);
        self::assertStringContainsString('DomainException: card declined', $entry['stackTrace']);
        self::assertSame(\DomainException::class, $entry['fields']['exceptionType']);
        self::assertSame('card declined', $entry['fields']['exceptionMessage']);
        self::assertSame(1, $entry['fields']['orderId']);
        self::assertArrayNotHasKey('exception', $entry['fields']);
    }

    public function testRecordTimestampIsUsed(): void
    {
        $handler = $this->handler();
        $logger = new Logger('app', [$handler]);
        $logger->setTimezone(new DateTimeZone('Asia/Tokyo'));
        $logger->info('when');
        $handler->flush();

        $sent = new DateTimeImmutable($this->transport->entries()[0]['timestamp']);
        self::assertLessThan(5, abs($sent->getTimestamp() - time()), 'converted to UTC, not shifted by the logger zone');
    }

    public function testHandlerLevelThresholdFilters(): void
    {
        $handler = $this->handler(level: Level::Warning);
        $logger = new Logger('app', [$handler]);
        $logger->info('quiet');
        $logger->warning('loud');
        $handler->flush();

        self::assertSame(['loud'], array_column($this->transport->entries(), 'message'));
    }

    public function testLaravelStyleNamedArguments(): void
    {
        // Laravel resolves `'with' => [...]` plus `level` as named constructor arguments.
        $handler = new ZipLoggerHandler(
            endpoint: 'http://stub.local',
            apiKey: 'zk_laravel',
            options: ['source' => 'web', 'transport' => $this->transport, 'registerShutdownFlush' => false],
            level: 300,
        );
        $logger = new Logger('laravel', [$handler]);
        $logger->info('filtered');
        $logger->error('kept');
        $handler->flush();

        self::assertSame('zk_laravel', $this->transport->requests[0]['headers']['X-Api-Key']);
        $entries = $this->transport->entries();
        self::assertSame(['kept'], array_column($entries, 'message'));
        self::assertSame('web', $entries[0]['source']);
    }

    public function testCanWrapAnExistingClient(): void
    {
        $client = new Client([
            'endpoint' => 'http://stub.local', 'apiKey' => 'zk_shared',
            'transport' => $this->transport, 'registerShutdownFlush' => false, 'flushInterval' => null,
        ]);
        $handler = new ZipLoggerHandler($client);
        self::assertSame($client, $handler->getClient());

        (new Logger('app', [$handler]))->info('shared');
        $client->flush();
        self::assertSame('shared', $this->transport->entries()[0]['message']);
    }

    public function testCloseFlushesTheBuffer(): void
    {
        $handler = $this->handler();
        $logger = new Logger('app', [$handler]);
        $logger->info('pending');
        self::assertCount(0, $this->transport->requests);

        $logger->close();
        self::assertCount(1, $this->transport->requests);
    }
}
