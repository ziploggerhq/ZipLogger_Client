# ziplogger (Ruby)

Ruby SDK for [ZipLogger](https://ziplogger.ai) — a standard-library-only client plus a
`::Logger` you can hand to Rails, Sidekiq, Rack, or your own code. Batching, retry with
backoff (429-aware), drop-on-backpressure, automatic enrichment. Ruby ≥ 3.0, **zero
dependencies**.

```bash
gem install ziplogger        # or in your Gemfile: gem "ziplogger"
```

## Logger (recommended)

```ruby
require "ziplogger"

client = Ziplogger::Client.new(endpoint: "https://app.ziplogger.ai", api_key: "zk_...")
logger = Ziplogger::Logger.new(client)          # a real ::Logger that ships every record

logger.info("Order created")
logger.info(message: "Order created", orderId: 83112, customer: "acme")   # hash => fields
logger.error(exception)                          # class + message + backtrace => stackTrace
logger.add(Logger::WARN, "Slow query", "ActiveRecord")                    # progname => category
```

## Rails

```ruby
# config/initializers/ziplogger.rb
if ENV["ZIPLOGGER_API_KEY"].present?
  client = Ziplogger::Client.new(endpoint: "https://app.ziplogger.ai",
                                 api_key: ENV["ZIPLOGGER_API_KEY"], source: "web")
  Rails.logger.broadcast_to(Ziplogger::Logger.new(client))      # Rails 7.1+
  # Rails < 7.1: Rails.logger.extend(ActiveSupport::Logger.broadcast(Ziplogger::Logger.new(client)))
end
```

Rails keeps writing its own log; ZipLogger receives a copy of every record. See
[docs/ruby.md](../docs/ruby.md) for Puma, Sidekiq, `Rails.error`, and request context.

## Core client (any framework, or none)

```ruby
client.info("job finished", jobId: 42)
client.error("job failed", exception: e, jobId: 42)
client.log(severity: :warn, message: "Stock low", fields: { sku: "KEN-AA-250" }, tags: ["inventory"])
client.close        # flush on shutdown (also installed as an at_exit hook)
```

## Behavior

A logging call never blocks and never raises. Entries buffer in a bounded queue (default
10,000), ship as NDJSON batches (default 100 per request, 2 s linger) to `/ingest/v1/logs`,
retry transient failures (429 honoring `Retry-After`, 408, 5xx, network) with exponential
backoff, and drop with a counter (`client.dropped`) when the queue overflows or retries
exhaust. Every entry is enriched with `environment` (`ZIPLOGGER_ENVIRONMENT`, `RAILS_ENV`,
`RACK_ENV`), `machineName`, `release` (`ZIPLOGGER_RELEASE`) and `commitSha`
(`ZIPLOGGER_COMMIT_SHA` / `GIT_COMMIT` / `COMMIT_SHA`), which power git regression detection.
A forked worker (Puma cluster mode, Unicorn) gets its own shipper thread automatically.

## Options

| Parameter | Default | Purpose |
|---|---|---|
| `endpoint:`, `api_key:` | required | Server origin and ingestion key |
| `source:`, `release:`, `commit_sha:`, `environment:`, `tags:` | auto | Enrichment overrides |
| `queue_size:` | 10000 | Max buffered entries (drops beyond) |
| `batch_size:` / `flush_interval:` | 100 / 2.0 s | Batching |
| `max_retries:`, `retry_base_delay:`, `retry_max_delay:` | 5 / 0.5 s / 30 s | Retry policy |
| `timeout:` | 10.0 s | Per-request HTTP timeout |

Methods: `log(...)`, `debug/info/warn/error/fatal(message, **fields)`, `flush(timeout: 5)`,
`close(timeout: 5)`, and the `dropped` counter.

## Test

```bash
bundle install && bundle exec rake test
```
