<?php

declare(strict_types=1);

namespace ZipLogger\Tests\Support;

use RuntimeException;

/**
 * Starts `php -S` with tests/stub/server.php as the router script, in a fresh temp directory,
 * and reads back what it recorded.
 */
final class StubServer
{
    /** @var resource|null */
    private $process = null;
    private string $dir;
    private int $port;

    public function __construct()
    {
        $this->dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'ziplogger-stub-' . bin2hex(random_bytes(4));
        if (!mkdir($this->dir, 0777, true) && !is_dir($this->dir)) {
            throw new RuntimeException('cannot create ' . $this->dir);
        }
        $this->reset();
        $this->port = self::freePort();

        $descriptors = [
            0 => ['pipe', 'r'],
            // Files, not pipes: nobody drains a pipe during the tests and php -S logs every request.
            1 => ['file', $this->dir . DIRECTORY_SEPARATOR . 'server.log', 'a'],
            2 => ['file', $this->dir . DIRECTORY_SEPARATOR . 'server.log', 'a'],
        ];
        $command = [PHP_BINARY, '-S', '127.0.0.1:' . $this->port, dirname(__DIR__) . '/stub/server.php'];
        $env = getenv();
        $env['ZL_STUB_DIR'] = $this->dir;

        $process = proc_open($command, $descriptors, $pipes, dirname(__DIR__, 2), $env, ['bypass_shell' => true]);
        if (!is_resource($process)) {
            throw new RuntimeException('could not start php -S');
        }
        $this->process = $process;
        fclose($pipes[0]);

        $deadline = microtime(true) + 15.0;
        while (microtime(true) < $deadline) {
            $status = proc_get_status($process);
            if (!$status['running']) {
                throw new RuntimeException('php -S exited early: ' . $this->serverLog());
            }
            $socket = @fsockopen('127.0.0.1', $this->port, $errno, $errstr, 0.25);
            if (is_resource($socket)) {
                fclose($socket);

                return;
            }
            usleep(20_000);
        }
        $this->stop();
        throw new RuntimeException('php -S did not start listening on port ' . $this->port . ': ' . $this->serverLog());
    }

    public function url(): string
    {
        return 'http://127.0.0.1:' . $this->port;
    }

    /** Truncate the recorded requests and clear the scripted status queue. */
    public function reset(): void
    {
        file_put_contents($this->dir . DIRECTORY_SEPARATOR . 'requests.ndjson', '');
        file_put_contents($this->dir . DIRECTORY_SEPARATOR . 'responses.json', '[]');
    }

    /** @param list<int> $statuses status codes served in order; 202 once the queue is empty */
    public function script(array $statuses): void
    {
        file_put_contents($this->dir . DIRECTORY_SEPARATOR . 'responses.json', json_encode(array_values($statuses)));
    }

    /** @return list<array{path: string, method: string, apiKey: ?string, contentType: ?string, lines: list<array<string, mixed>>, status: int}> */
    public function requests(): array
    {
        $raw = (string) @file_get_contents($this->dir . DIRECTORY_SEPARATOR . 'requests.ndjson');
        $out = [];
        foreach (explode("\n", $raw) as $line) {
            if (trim($line) !== '') {
                $out[] = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
            }
        }

        return $out;
    }

    /** @return list<array<string, mixed>> */
    public function waitFor(int $count, float $timeout = 5.0): array
    {
        $deadline = microtime(true) + $timeout;
        do {
            $requests = $this->requests();
            if (count($requests) >= $count) {
                return $requests;
            }
            usleep(20_000);
        } while (microtime(true) < $deadline);

        throw new RuntimeException(sprintf('expected %d requests, saw %d', $count, count($requests)));
    }

    public function stop(): void
    {
        if (is_resource($this->process)) {
            proc_terminate($this->process);
            // Give it a moment, then make sure.
            for ($i = 0; $i < 50 && proc_get_status($this->process)['running']; $i++) {
                usleep(20_000);
            }
            if (proc_get_status($this->process)['running']) {
                proc_terminate($this->process, 9);
            }
            proc_close($this->process);
            $this->process = null;
        }
        foreach (glob($this->dir . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($this->dir);
    }

    private function serverLog(): string
    {
        return (string) @file_get_contents($this->dir . DIRECTORY_SEPARATOR . 'server.log');
    }

    private static function freePort(): int
    {
        $socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        if (!is_resource($socket)) {
            throw new RuntimeException('cannot allocate a port: ' . $errstr);
        }
        $name = (string) stream_socket_get_name($socket, false);
        fclose($socket);
        $port = (int) substr((string) strrchr($name, ':'), 1);
        if ($port <= 0) {
            throw new RuntimeException('unexpected socket name ' . $name);
        }

        return $port;
    }
}
