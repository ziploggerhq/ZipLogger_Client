<?php

declare(strict_types=1);

namespace ZipLogger\Tests;

use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;
use Psr\Log\LogLevel;
use ZipLogger\Client;
use ZipLogger\Psr\Logger;
use ZipLogger\Tests\Support\FakeTransport;

final class PsrLoggerTest extends TestCase
{
    private FakeTransport $transport;
    private Client $client;

    protected function setUp(): void
    {
        $this->transport = new FakeTransport();
        $this->client = new Client([
            'endpoint' => 'http://stub.local', 'apiKey' => 'zk_test',
            'transport' => $this->transport, 'registerShutdownFlush' => false, 'flushInterval' => null,
        ]);
    }

    public function testImplementsPsr3(): void
    {
        self::assertInstanceOf(LoggerInterface::class, new Logger($this->client));
    }

    public function testInterpolatesPlaceholdersAndKeepsContextAndTemplate(): void
    {
        $log = new Logger($this->client, 'orders');
        $log->info('Order {orderId} created for {customer} ({missing})', ['orderId' => 83112, 'customer' => 'acme', 'unused' => true]);
        $this->client->flush();

        $entry = $this->transport->entries()[0];
        self::assertSame('Order 83112 created for acme ({missing})', $entry['message']);
        self::assertSame('info', $entry['severity']);
        self::assertSame('orders', $entry['fields']['category']);
        self::assertSame(83112, $entry['fields']['orderId']);
        self::assertSame('acme', $entry['fields']['customer']);
        self::assertTrue($entry['fields']['unused']);
        self::assertSame('Order {orderId} created for {customer} ({missing})', $entry['fields']['messageTemplate']);
    }

    public function testNoTemplateFieldWhenNothingWasInterpolated(): void
    {
        $log = new Logger($this->client);
        $log->warning('plain text', ['k' => 'v']);
        $this->client->flush();

        $entry = $this->transport->entries()[0];
        self::assertSame('plain text', $entry['message']);
        self::assertSame('warn', $entry['severity']);
        self::assertArrayNotHasKey('messageTemplate', $entry['fields']);
        self::assertArrayNotHasKey('category', $entry['fields']);
    }

    public function testContextExceptionBecomesStackTrace(): void
    {
        $log = new Logger($this->client);
        $e = new \RuntimeException('nope');
        $log->error('Failed: {exception}', ['exception' => $e]);
        $this->client->flush();

        $entry = $this->transport->entries()[0];
        self::assertSame('Failed: RuntimeException: nope', $entry['message']);
        self::assertStringContainsString('RuntimeException: nope', $entry['stackTrace']);
        self::assertSame(\RuntimeException::class, $entry['fields']['exceptionType']);
        self::assertArrayNotHasKey('exception', $entry['fields']);
    }

    public function testAllPsrLevelsMap(): void
    {
        $log = new Logger($this->client);
        foreach ([LogLevel::DEBUG, LogLevel::INFO, LogLevel::NOTICE, LogLevel::WARNING, LogLevel::ERROR, LogLevel::CRITICAL, LogLevel::ALERT, LogLevel::EMERGENCY] as $level) {
            $log->log($level, $level);
        }
        $log->log('made-up', 'x');
        $this->client->flush();

        self::assertSame(
            ['debug', 'info', 'info', 'warn', 'error', 'fatal', 'fatal', 'fatal', 'info'],
            array_column($this->transport->entries(), 'severity'),
        );
    }

    public function testStringableMessagesAndNonScalarPlaceholders(): void
    {
        $log = new Logger($this->client);
        $message = new class () implements \Stringable {
            public function __toString(): string
            {
                return 'items={items} flag={flag} none={none}';
            }
        };
        $log->debug($message, ['items' => ['a', 'b'], 'flag' => false, 'none' => null]);
        $this->client->flush();

        self::assertSame('items=["a","b"] flag=false none=', $this->transport->entries()[0]['message']);
    }
}
