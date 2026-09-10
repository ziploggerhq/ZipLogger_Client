# loyalty (PHP)

Northwind Coffee's loyalty service: points, tiers, and how much a customer must still spend to
reach the next tier. Plain PHP on the built-in web server, Monolog as the application logger,
and the `ziplogger/ziplogger` Monolog handler shipping every record to ZipLogger.

What it demonstrates:

- Monolog `context` arrays becoming searchable ZipLogger fields (`customerId`, `tier`, `points`,
  `durationMs`), and the channel name arriving as `category`.
- `['exception' => $e]` becoming a real stack trace, the input to "which commit broke this?".
- PHP's request lifecycle: each request buffers its own records and the client's shutdown
  function ships them after the request finishes, so the response never waits on the network.

## The deliberate defect

`Loyalty::spendToNextTier()` divides the points still needed by the tier's points-per-dollar.
Guests earn zero points per dollar, so for a guest the division is by zero and PHP 8 throws
`DivisionByZeroError`. About a fifth of the synthetic customers are guests, so the error shows up
steadily, with a trace pointing at the real line in `src/Loyalty.php`.

## Run it

```bash
composer install
ZIPLOGGER_API_KEY=zk_... php -S 0.0.0.0:8080 public/index.php

# in another terminal
curl -s http://127.0.0.1:8080/loyalty/cust-1234
curl -s -X POST http://127.0.0.1:8080/loyalty/cust-1234/earn -d '{"amount": 12.5}'
php bin/traffic.php          # synthetic traffic every DEMO_INTERVAL_SECONDS (default 5)
```

Or with Docker, which starts both the server and the traffic loop:

```bash
docker build -t northwind-loyalty .
docker run --rm -e ZIPLOGGER_API_KEY=zk_... -p 8080:8080 northwind-loyalty
```

Environment: `ZIPLOGGER_ENDPOINT` (default `https://app.ziplogger.ai`), `ZIPLOGGER_API_KEY`
(required), `ZIPLOGGER_ENVIRONMENT`, `DEMO_INTERVAL_SECONDS`, and `LOYALTY_URL` for the traffic
script.

The SDK is installed from Packagist like every other example. To run against the SDK source in
this repository instead (for instance before a release is tagged), add a path repository to
`composer.json` and re-run `composer install`:

```json
"repositories": [{ "type": "path", "url": "../../sdk_php" }]
```

## Files

| File | Role |
|---|---|
| `public/index.php` | Router, Monolog setup, the two endpoints, the top-level `catch (Throwable)` |
| `src/Loyalty.php` | Tiers and arithmetic, including the bug |
| `src/Accounts.php` | Deterministic pretend balances |
| `bin/traffic.php` | Traffic generator |
