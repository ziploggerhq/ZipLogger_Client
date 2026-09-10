# Northwind Coffee — one demo service per SDK

Eight small services for a fictional coffee roastery, one in each language ZipLogger
supports. They exist for two reasons: to show what ZipLogger looks like with live data
in every language, and to prove each published SDK actually works by running it.

Every service installs its SDK from the public registry, so what runs here is exactly
what a customer gets. Two of them cannot do that yet: `ruby-notifications` and
`php-loyalty` install `ziplogger` from RubyGems and Packagist, where the packages are not
published (see [PUBLISHING.md](../PUBLISHING.md)). They are therefore behind the compose
profile `preview` and are skipped by a plain `docker compose up`.

| Service | Language | SDK | What it demonstrates |
|---|---|---|---|
| [checkout](dotnet-checkout) | .NET 8 | `ZipLogger.Extensions.Logging`, `ZipLogger.Metrics.AspNetCore` | `ILogger` shipping unchanged, request duration/route/status as metrics, and `IEventTracker` for server-authoritative revenue |
| [orders](node-orders) | Node.js 22 | `ziplogger` via Pino transport | adopting ZipLogger without changing a single logging call |
| [recommendations](python-recommendations) | Python 3.12 | `ziplogger` logging handler | `extra={...}` becoming searchable fields, `exc_info` becoming a stack trace |
| [inventory](go-inventory) | Go 1.22 | `sdk_go` slog handler | `log/slog` as the interface, errors mapped to exception fields |
| [payments](java-payments) | Java 17 | `dev.ziplogger:ziplogger` JUL handler | attaching to `java.util.logging` in one line |
| [notifications](ruby-notifications) | Ruby 3.3 | `ziplogger` via `Ziplogger::Logger` | a `::Logger` subclass shipping and printing from one logger, Hash messages as fields, `exception:` as a stack trace |
| [loyalty](php-loyalty) | PHP 8.3 | `ziplogger/ziplogger` Monolog handler | Monolog context becoming fields, `['exception' => $e]` becoming a stack trace, and the per-request shutdown flush |
| [storefront](browser-storefront) | Browser | `@ziplogger/browser` | uncaught errors, failed fetches, browser spans sharing a trace id with the server, and `track()` / `identify()` product analytics |

## Every failure here is real

Each service contains one deliberate defect, and it is a real one: a line that actually
throws, not a hand-written error string. That matters because it makes the demo honest.
The stack trace ZipLogger receives points at a real line in a real commit in this
repository, so "which commit broke this?" resolves to an actual change.

- **recommendations** divides by the basket total, which is zero for a wholesale shopper
  with an empty basket
- **orders** reserves more units than the warehouse holds and throws `OutOfStockError`
- **inventory** parses a feed row whose quantity column is `n/a`
- **payments** converts a currency that was added to the storefront but not to the rate table
- **checkout** applies a promo code that has no configured discount rate
- **notifications** renders a template for a locale the storefront offers (`pt-BR`) but the
  template table does not know, and `Hash#fetch` raises `KeyError`
- **loyalty** works out how much a guest must spend to reach Bronze by dividing by the tier's
  points-per-dollar, which is zero for guests, and throws `DivisionByZeroError`
- **storefront** reads `.items` off a null cart, uncaught, the way front-end bugs really happen

## Analytics, not just logs

The storefront and the checkout API also demonstrate product events, which answer different
questions than logs do. Browsing the storefront builds a real funnel:

```
catalog_viewed -> product_viewed -> checkout_started -> order_placed
```

Signing in calls `identify()`, so the anonymous browsing that preceded it belongs to the
account rather than to a second person. The storefront passes its `identity` to the checkout
API, which tracks `order_confirmed` against the same ids — revenue is recorded server-side
because it is not something to take the client's word for.

The six background services ship logs, traces and metrics only: `sdk_node`, `sdk_python`,
`sdk_go`, `sdk_java`, `sdk_ruby` and `sdk_php` have no event API yet.

Deploying this on a server behind a hostname, with a read-only login to share with
clients, is covered in [DEPLOY.md](DEPLOY.md).

## Running it

```bash
cp .env.example .env       # fill in the two API keys
docker compose -f docker-compose.demo.yml up -d --build

# once ziplogger is on RubyGems and Packagist, add the Ruby and PHP services:
docker compose -f docker-compose.demo.yml --profile preview up -d --build
```

Only the storefront publishes a port. The checkout API is reachable at `/checkout` on the
storefront's own origin, which keeps browser calls same-origin so `instrumentFetch`
propagates its `traceparent` without extra configuration.

The background services generate traffic on a timer, so a demo workspace always has live
data. `DEMO_INTERVAL_SECONDS` controls the pace.

## Two API keys, on purpose

The storefront key ends up in page source, because anything a browser sends is visible to
whoever opens devtools. That is inherent to browser telemetry, not a ZipLogger limitation.
Use a key dedicated to browser traffic, scoped to the workspace you are willing to have
public, and keep the server key separate. The compose file requires both and refuses to
start without them rather than silently sharing one.

## Running one service on its own

Each directory runs standalone if you would rather not use Docker:

```bash
cd python-recommendations && pip install ziplogger==0.3.3 && ZIPLOGGER_API_KEY=zk_... python app.py
cd node-orders           && npm install && ZIPLOGGER_API_KEY=zk_... node app.js
cd go-inventory          && ZIPLOGGER_API_KEY=zk_... go run .
cd java-payments         && mvn package && ZIPLOGGER_API_KEY=zk_... java -jar target/payments-1.0.0.jar
cd dotnet-checkout       && ZIPLOGGER_API_KEY=zk_... dotnet run
cd browser-storefront    && npm install && python -m http.server 8081   # then edit config.js
cd ruby-notifications    && gem install ziplogger && ZIPLOGGER_API_KEY=zk_... ruby app.rb
cd php-loyalty           && composer install && ZIPLOGGER_API_KEY=zk_... php -S 0.0.0.0:8080 public/index.php   # then: php bin/traffic.php
```

The last two need the gem and the Composer package to exist; until they are published, point
them at the SDK sources in this repository (`gem 'ziplogger', path: '../../sdk_ruby'`, or a
Composer `path` repository pointing at `../../sdk_php`).

All eight read the same variables: `ZIPLOGGER_ENDPOINT`, `ZIPLOGGER_API_KEY`,
`ZIPLOGGER_ENVIRONMENT`, and `DEMO_INTERVAL_SECONDS`.

## A note on the .NET example

`dotnet-checkout` ships a `NuGet.config` with `<clear />`. Without it, a machine-level
private feed can be consulted first and fail the restore with a 401 on a machine that has
one configured. Clearing sources means this example restores from nuget.org alone, the way
anyone cloning the repository would.

It also sets `AddFilter("Microsoft", LogLevel.Warning)`. Left at the default, ASP.NET
Core's own Information-level request logging outnumbers the application's own lines
several to one, which is worth knowing before you point a real service at ZipLogger.
