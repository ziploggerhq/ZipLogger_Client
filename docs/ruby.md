# Ruby

A standard-library-only client plus a `::Logger` subclass that ships every record. Batching,
retries with backoff (429-aware), drop-on-backpressure, and automatic enrichment. **No
dependencies**: `net/http`, `json`, `socket`, and `logger` are all it uses. Ruby 3.0 or newer.

Because `Ziplogger::Logger` is a real `::Logger`, anything that takes a logger (Rails, Sidekiq,
Rack, ActiveJob, your own classes) can ship to ZipLogger without changing a logging call.

## Install

```bash
gem install ziplogger
```

```ruby
# Gemfile
gem "ziplogger"
```

## Usage

```ruby
require "ziplogger"

client = Ziplogger::Client.new(
  endpoint: "https://app.ziplogger.ai",
  api_key:  ENV.fetch("ZIPLOGGER_API_KEY"),
  source:   "billing-worker",                 # optional; defaults to the script name
)

logger = Ziplogger::Logger.new(client)

logger.info("Order created")
logger.info(message: "Order created", orderId: 83112, customer: "acme")

begin
  charge(order)
rescue => e
  logger.error(e)              # class + message + backtrace to ZipLogger's stackTrace field
end
```

- A **Hash** message uses its `:message` key as the log line; every other key becomes a searchable
  field.
- An **Exception** message ships its class, message, and backtrace (with the `cause` chain) as
  `stackTrace`, plus `fields.exceptionType` and `fields.exceptionMessage`. That trace is what
  feeds git regression detection.
- `progname` (the third argument to `add`, or the logger's default) becomes `fields.category`.
- Enrichment is automatic: `environment`, `machineName`, plus `release` and `commitSha` from the
  constructor or the `ZIPLOGGER_RELEASE` / `ZIPLOGGER_COMMIT_SHA` / `GIT_COMMIT` variables.

Keep message templates constant and put the varying parts in fields. `logger.info(message: "Order
created", orderId: id)` is one pattern ZipLogger can cluster and count; `logger.info("Order #{id}
created")` is a new pattern per order and ruins grouping.

### Direct client

The client has the same surface when you would rather not go through `::Logger`:

```ruby
client.info("job finished", jobId: 42)
client.warn("stock low", sku: "KEN-AA-250", remaining: 3)
client.error("job failed", exception: e, jobId: 42)

client.log(severity: :error, message: "payment declined",
           fields: { orderId: 83112, gateway: "stripe" },
           exception: e, tags: ["payments"], timestamp: Time.now)

client.flush           # ship what is buffered; the client stays usable
client.close           # flush (bounded) and stop; also runs at exit
```

`debug`, `info`, `warn`, `error`, and `fatal` take a message and keyword fields; `exception:` is
the one reserved keyword. `log` accepts `severity`, `message`, `fields`, `exception`,
`stack_trace`, `timestamp`, and per-entry `source`, `release`, `commit_sha`, and `tags`.

### Field types

Strings, integers, floats, booleans, `nil`, arrays, and nested hashes go through as JSON. Symbols
become strings, `Time` becomes ISO-8601, and anything else is stringified with `to_s`, so a model
object arrives readable rather than failing serialisation. Pass the scalars you want to filter or
range-query on as their own fields:

```ruby
logger.info(message: "Order created", orderId: order.id, total: order.total.to_f,
            currency: order.currency)
```

## Rails

### Shipping Rails.logger

Rails 7.1 and newer make `Rails.logger` an `ActiveSupport::BroadcastLogger`, so adding a
destination is one call. Rails keeps writing its own log file or stdout; ZipLogger receives a copy
of every record, including ActionController's request lines and ActiveJob's job lines.

```ruby
# config/initializers/ziplogger.rb
if ENV["ZIPLOGGER_API_KEY"].present?
  ZIPLOGGER = Ziplogger::Client.new(
    endpoint: ENV.fetch("ZIPLOGGER_ENDPOINT", "https://app.ziplogger.ai"),
    api_key:  ENV["ZIPLOGGER_API_KEY"],
    source:   "web",
  )
  Rails.logger.broadcast_to(Ziplogger::Logger.new(ZIPLOGGER, level: Logger::INFO))
end
```

The same thing expressed as configuration, if you prefer it in `config/environments/production.rb`:

```ruby
config.logger = ActiveSupport::BroadcastLogger.new(
  ActiveSupport::Logger.new($stdout),
  Ziplogger::Logger.new(ZIPLOGGER),
)
```

Rails 7.0 and older have no `BroadcastLogger` class; extend the existing logger instead:

```ruby
Rails.logger.extend(ActiveSupport::Logger.broadcast(Ziplogger::Logger.new(ZIPLOGGER)))
```

Attaching only when a key is present keeps development and test quiet, and `level: Logger::INFO`
keeps debug-level SQL out of your quota. Filter noise in Rails (`config.log_level`, quieting
`ActiveRecord::Base.logger`) rather than in the SDK: everything the SDK accepts counts.

### Unhandled exceptions with a real stack trace

Rails logs an unhandled exception as pre-rendered text: the class, the message, and the backtrace
joined into one string. `Ziplogger::Logger` recognises that shape, keeps the first line as the
message, and ships the whole text as `stackTrace`, so regression attribution works out of the box.

For the exception object itself, with the request context Rails attaches, subscribe to the error
reporter (Rails 7.0+). Unhandled controller and job exceptions, plus anything you pass to
`Rails.error.handle` or `Rails.error.report`, arrive here:

```ruby
# config/initializers/ziplogger.rb (continued)
class ZipLoggerErrorSubscriber
  def initialize(client)
    @client = client
  end

  def report(error, handled:, severity:, context:, source: nil)
    @client.log(severity: handled ? :warn : :error, message: error.message, exception: error,
                fields: context.merge(handled: handled, errorSource: source))
  end
end

Rails.error.subscribe(ZipLoggerErrorSubscriber.new(ZIPLOGGER)) if defined?(ZIPLOGGER)
```

### Request context on every line

`config.log_tags` are applied by the formatter of the logger that writes them, so tags do not reach
a broadcast destination. To stamp request data on shipped records, log a Hash and read from
`ActiveSupport::CurrentAttributes`:

```ruby
class Current < ActiveSupport::CurrentAttributes
  attribute :request_id, :user_id
end

# anywhere
logger.info(message: "Cart updated", requestId: Current.request_id, userId: Current.user_id,
            items: cart.size)
```

### Puma, Unicorn, and other forking servers

The client owns a background thread, and a forked worker does not inherit threads. The SDK detects
the new process id on the first `log` call after a fork, discards the parent's buffered copies (the
parent ships those itself), and starts a fresh shipper, so an initializer created before
`preload_app!` keeps working in every worker. Nothing to configure; `on_worker_boot` hooks are not
required.

## Sidekiq and background jobs

Jobs log through `Rails.logger` (or Sidekiq's logger), so the Rails setup above covers job output.
Two additions make the picture complete: exceptions that fail a job, and a clean flush on shutdown.

```ruby
# config/initializers/sidekiq.rb
Sidekiq.configure_server do |config|
  config.error_handlers << lambda do |error, context, _config = nil|
    ZIPLOGGER.log(severity: :error, message: error.message, exception: error,
                  fields: { jobClass: context.dig(:job, "class"), jid: context.dig(:job, "jid"),
                            queue: context.dig(:job, "queue"), retryCount: context.dig(:job, "retry_count") })
  end
  config.on(:shutdown) { ZIPLOGGER.close(timeout: 5) }
end
```

(Sidekiq 6 passes two arguments to error handlers, Sidekiq 7 three; the lambda accepts both.)

For a plain script or a cron job, `close` runs automatically at exit. If the job is very short,
lower the linger so the batch ships before the process ends:

```ruby
client = Ziplogger::Client.new(endpoint: ..., api_key: ..., flush_interval: 0.25)
```

## Rack, Sinatra, and anything that writes formatted lines

Middleware such as `Rack::CommonLogger` wants an object with `write(String)`. `Ziplogger::LogDevice`
is that object: lines in the stdlib `Logger` format keep their severity and progname, any other text
ships one entry per line.

```ruby
device = Ziplogger::LogDevice.new(client, severity: :info, category: "http")
use Rack::CommonLogger, device

# or as the device of a stock ::Logger
logger = Logger.new(Ziplogger::LogDevice.new(client))
```

## Severity mapping

| `::Logger` level | ZipLogger severity |
|---|---|
| `DEBUG` | `debug` |
| `INFO` | `info` |
| `WARN` | `warn` |
| `ERROR` | `error` |
| `FATAL` | `fatal` |
| `UNKNOWN` | `error` |

On the client, `severity:` accepts strings or symbols; `warning` maps to `warn`, `critical` to
`fatal`, and anything unrecognised to `info`.

## Behavior

A logging call never blocks and never raises. Entries go into a bounded in-memory queue (default
10,000); a background thread batches them (default 100 per request, 2 s linger) and POSTs NDJSON to
`/ingest/v1/logs`. Transient failures (429 with `Retry-After`, 408, 5xx, network) retry with
exponential backoff and jitter; non-transient responses (400, 401, 403) and exhausted retries drop
the batch and increment `client.dropped`. `close` runs at exit and waits at most five seconds.

The linger is the maximum age of the oldest buffered entry, not an idle timeout: a service logging
steadily still ships every two seconds.

Watch `client.dropped` in long-running services. A non-zero value means real loss, either from a
full queue or from an unreachable endpoint:

```ruby
warn "ziplogger dropped #{client.dropped} entries" if client.dropped.positive?
```

## Options

| Parameter | Default | Purpose |
|---|---|---|
| `endpoint:`, `api_key:` | required | Server origin and ingestion key |
| `source:` | script name | Service name |
| `release:`, `commit_sha:` | env vars | Build identity, powers regression attribution |
| `environment:` | `production` | Deployment environment |
| `tags:` | none | Tags added to every entry |
| `queue_size:` | 10000 | Max buffered entries (drops beyond) |
| `batch_size:` | 100 | Entries per request |
| `flush_interval:` | 2.0 s | Max age of the oldest entry before a partial batch ships |
| `max_retries:` | 5 | Retry attempts per batch |
| `retry_base_delay:` | 0.5 s | First backoff delay |
| `retry_max_delay:` | 30 s | Backoff ceiling |
| `timeout:` | 10.0 s | Per-request HTTP timeout |

`endpoint:` and `api_key:` are validated in the constructor: a missing value raises
`ArgumentError` at startup rather than failing silently later.

### Environment variables

| Variable | Used for | Fallbacks |
|---|---|---|
| `ZIPLOGGER_SOURCE` | `source` | `$PROGRAM_NAME` without its extension |
| `ZIPLOGGER_RELEASE` | `release` | none |
| `ZIPLOGGER_COMMIT_SHA` | `commitSha` | `GIT_COMMIT`, `COMMIT_SHA` |
| `ZIPLOGGER_ENVIRONMENT` | `fields.environment` | `ENVIRONMENT`, `RAILS_ENV`, `RACK_ENV`, then `production` |

Options passed in code always win. See the [configuration reference](configuration.md) for the same
concepts across every SDK.

## Docker and Kubernetes

```dockerfile
ENV ZIPLOGGER_SOURCE=orders-api ZIPLOGGER_ENVIRONMENT=production
ARG GIT_COMMIT
ENV ZIPLOGGER_COMMIT_SHA=$GIT_COMMIT
```

## Tracing

Use OpenTelemetry auto-instrumentation and point the OTLP exporter at ZipLogger; there is nothing
ZipLogger-specific to install:

```ruby
# Gemfile
gem "opentelemetry-sdk"
gem "opentelemetry-exporter-otlp"
gem "opentelemetry-instrumentation-all"
```

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://app.ziplogger.ai \
OTEL_EXPORTER_OTLP_HEADERS=X-Api-Key=zk_... \
OTEL_SERVICE_NAME=orders-api \
  bundle exec puma
```

Then stamp the trace id onto your logs so each line links to its waterfall:

```ruby
span = OpenTelemetry::Trace.current_span
logger.info(message: "Order created", orderId: id, traceId: span.context.hex_trace_id,
            spanId: span.context.hex_span_id)
```

See [tracing](tracing.md#correlating-logs-with-traces).

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing arrives from a script | The process was killed before the linger elapsed. Call `client.close`, or lower `flush_interval`. |
| Nothing arrives from Rails | The initializer is guarded by an env var that is not set in that environment. |
| Nothing arrives from Puma workers | Upgrade: fork detection needs 0.4.0 or newer. |
| Fields missing | They must be keys of a Hash message (or `fields:` on the client), not interpolated into the string. |
| `stackTrace` empty | Pass the exception object (`logger.error(e)`), not `e.message`. |
| `client.dropped` climbing | Queue full or endpoint unreachable. Check the key, then raise `batch_size`. |
| Every message is its own pattern | String interpolation in the message. Move the variable parts into fields. |
