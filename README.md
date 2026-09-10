# ZipLogger client documentation

[ZipLogger](https://ziplogger.ai) is log management that finds the commit that broke production:
search, dashboards, alerts, log-pattern clustering, distributed tracing, request metrics, AI
analysis, and git regression attribution.

This repository is the public integration documentation: how to send telemetry to ZipLogger from
any language, framework, or shipper, and how to read it back out. Every integration converges into
the same pipeline, so all features work identically regardless of transport.

ZipLogger is a hosted service. Your workspace lives at `https://app.ziplogger.ai` and your apps
only need outbound HTTPS to reach it. There is nothing to install or operate.

## Quick start

1. [Create a free account](https://ziplogger.ai/signup.html) (1,000 logs/day, free forever).
2. In the app, create an ingestion key under **Settings → API keys** (`zk_...`).
3. Send your first log:

```bash
curl -X POST https://app.ziplogger.ai/ingest/v1/logs \
  -H "X-Api-Key: zk_..." \
  -H "Content-Type: application/json" \
  -d '{"message":"hello from curl","severity":"info","source":"quickstart"}'
```

Your log is searchable within seconds.

## Integrations

### Logs

| Guide | Package |
|---|---|
| [.NET](docs/dotnet.md): `ILogger` provider, Serilog sink, core client | `ZipLogger.Extensions.Logging`, `ZipLogger.Serilog`, `ZipLogger.Client` |
| [Python](docs/python.md): stdlib `logging` handler | `ziplogger` (pip) |
| [Node.js](docs/nodejs.md): core client plus Pino and Winston transports | `ziplogger` (npm) |
| [Go](docs/go.md): client plus `log/slog` handler | `ziplogger` (Go module) |
| [Java](docs/java.md): JDK-only client plus `java.util.logging` handler | `dev.ziplogger:ziplogger` (Maven) |
| [Ruby](docs/ruby.md): `::Logger` subclass plus core client, Rails and Sidekiq recipes | `ziplogger` (RubyGems) |
| [PHP](docs/php.md): Monolog handler (Laravel, Symfony), PSR-3 logger, core client | `ziplogger/ziplogger` (Composer) |
| [Browser / React](docs/browser.md): error capture, React error boundary, fetch tracing, session replay | `@ziplogger/browser` (npm) |
| [OpenTelemetry](docs/opentelemetry.md): native OTLP/HTTP logs receiver | any OTel SDK or Collector |
| [Fluent Bit / Vector](docs/shippers.md): ship logs from apps you cannot modify | any shipper |
| [HTTP ingestion API](docs/http-api.md): raw log ingestion reference | anything that can POST JSON |

### Traces, metrics, and everything else

| Guide | What it covers |
|---|---|
| [Distributed tracing](docs/tracing.md) | OTLP/HTTP `/v1/traces`, span mapping, browser-to-backend traces, trace/log correlation |
| [Product analytics (Events)](docs/events.md) | `Track()`/`Identify()`, sessions, the `/ingest/v1/events` endpoint, and error-to-journey correlation |
| [Session replay](docs/session-replay.md) | Watch what a user did before an error: DOM recording, masking rules, sampling, retention, and what it costs the page |
| [Migrate from Mixpanel](docs/migrate-from-mixpanel.md) | Point an existing Mixpanel SDK at ZipLogger: endpoint, token, identity mapping, historical import |
| [Request metrics (APM)](docs/metrics.md) | ASP.NET Core middleware, custom metrics, and the `/ingest/v1/metrics` endpoint for any stack |
| [MCP server](docs/mcp.md) | Query your workspace from Claude Code, Cursor, or any MCP client |
| [Alerts and webhooks](docs/alerts-webhooks.md) | Webhook payload contract and the sandboxed custom-script API |
| [Query API](docs/query-api.md) | Read logs, traces, metrics, and patterns back out programmatically |
| [Configuration reference](docs/configuration.md) | Every `ZIPLOGGER_*` environment variable and option, side by side |

## SDK source

The SDKs themselves live in this repository, so you can read exactly what runs inside your app:

| Language | Source | Install |
|---|---|---|
| Python | [`sdk_python/`](sdk_python) | `pip install ziplogger` |
| Node.js | [`sdk_node/`](sdk_node) | `npm install ziplogger` |
| Browser / React | [`sdk_browser/`](sdk_browser) | `npm install @ziplogger/browser` |
| Go | [`sdk_go/`](sdk_go) | `go get github.com/ziploggerhq/ZipLogger_Client/sdk_go` |
| Java | [`sdk_java/`](sdk_java) | `dev.ziplogger:ziplogger` (Maven Central) |
| Ruby | [`sdk_ruby/`](sdk_ruby) | `gem install ziplogger` |
| PHP | [`sdk_php/`](sdk_php) | `composer require ziplogger/ziplogger` |
| .NET | published from the platform repo | `dotnet add package ZipLogger.Extensions.Logging` |

All packages are MIT licensed and share one version number (currently 0.3.3, and 0.4.0 for the
Ruby and PHP SDKs added since). Every package is dependency-free apart from the optional Pino and
Winston peer packages in the Node SDK and the `psr/log` interface package in the PHP SDK (Monolog
is optional there too).

The .NET, Python, Node, browser, Go and Java packages are published and installable today. The npm
packages carry provenance attestations and the Maven artifacts are GPG signed, so you can verify
that what you install was built from this repository. **Ruby and PHP are not on RubyGems and
Packagist yet** — their CI jobs are wired and their tests pass, but the registry accounts are still
to be created, so install them from this repository (`gem 'ziplogger', path:` / a Composer `path`
repository) until the first release. See [PUBLISHING.md](PUBLISHING.md) for how a release is cut
and what is left to set up.

## Shared delivery semantics

Every official SDK behaves the same way, so you can trust them in production:

- **A logging call never blocks and never throws.** Entries buffer in a bounded in-memory queue
  (default 10,000) and ship in the background as NDJSON batches (default 100/batch, 2 s linger).
- **Drop over grow.** When the buffer is full, new entries are dropped and counted rather than
  growing memory without bound. Every SDK exposes that counter, so you can alert on it.
- **Retry with exponential backoff** on transient failures (429 honoring `Retry-After`, 408, 5xx,
  network errors). Non-transient responses (400/401) drop the batch immediately.
- **Automatic enrichment.** `source`, `release`, `commitSha`, `environment`, and `machineName` are
  attached from your build and runtime, overridable via options or `ZIPLOGGER_*` environment
  variables. Release plus commit SHA are what power git regression attribution.
- **Exceptions become `stackTrace`**, which feeds "which commit broke this?" analysis.
- **Graceful shutdown.** Close or dispose flushes the buffer with a bounded timeout.

See the [configuration reference](docs/configuration.md) for the exact option name in each language.

## Quotas

Paid plans are sold by **daily ingest volume**: 1 GB a day on Pro, 3 GB on Team, 10 GB on Business, covering logs and traces together and measured on the payload you send. There is no overage, so exceeding the day's volume pauses ingestion rather than adding to your invoice. The Free plan is count-based instead: 1,000 log lines a day and 30,000 a month.

Either way an exhausted quota answers `429` with a `Retry-After` header pointing at the next UTC midnight, plus a JSON body showing current usage. Official SDKs honor it automatically, so your application is never blocked by an exhausted quota.

See [pricing](https://ziplogger.ai/pricing.html) for plan limits and [the HTTP API reference](docs/http-api.md#responses) for the response body.

## Support

- Documentation site: [ziplogger.ai/docs.html](https://ziplogger.ai/docs.html)
- Support: [support@ziplogger.ai](mailto:support@ziplogger.ai)
- Sales and partnerships: [contact@ziplogger.ai](mailto:contact@ziplogger.ai)
