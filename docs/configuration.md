# Configuration reference

Every SDK takes the same set of concepts under language-idiomatic names. This page is the
cross-language index: find the concept once, then use the column for your language.

## Required settings

| Setting | Value |
|---|---|
| Endpoint | `https://app.ziplogger.ai` (the SDKs append `/ingest/v1/logs` for you) |
| API key | An ingestion key created under **Settings → API keys**, shaped `zk_...` |

The key travels as the `X-Api-Key` header. Keys can be rotated and revoked independently, so use a
separate key per application (and always a separate one for browser traffic, which is public by
nature).

## Environment variables

Every SDK reads these when the matching option is not set in code, so the same build can run in
several environments without a code change. Options passed in code always win.

| Variable | Meaning | Fallbacks also honored |
|---|---|---|
| `ZIPLOGGER_SOURCE` | Service name, drives filtering and dashboards | assembly / executable / script name |
| `ZIPLOGGER_RELEASE` | Version of the running build | .NET informational version, nearest `package.json` version |
| `ZIPLOGGER_COMMIT_SHA` | Git commit of the running build | `GIT_COMMIT`, `COMMIT_SHA`, .NET SourceLink `+sha` suffix |
| `ZIPLOGGER_ENVIRONMENT` | Deployment environment | `DOTNET_ENVIRONMENT`, `ASPNETCORE_ENVIRONMENT`, `NODE_ENV`, `APP_ENV` (PHP), `RAILS_ENV`, `RACK_ENV` (Ruby), `ENVIRONMENT`; defaults to `production` |

`release` and `commitSha` are the two that matter most: they are the inputs to git regression
attribution. Without them ZipLogger can still cluster and search your errors, but it cannot tell
you which commit introduced one.

A typical CI injection looks like this:

```bash
# GitHub Actions
ZIPLOGGER_RELEASE=${{ github.ref_name }}
ZIPLOGGER_COMMIT_SHA=${{ github.sha }}
```

```yaml
# Kubernetes
env:
  - name: ZIPLOGGER_SOURCE
    value: orders-api
  - name: ZIPLOGGER_ENVIRONMENT
    value: production
  - name: ZIPLOGGER_RELEASE
    value: "2026.8.1"
  - name: ZIPLOGGER_COMMIT_SHA
    valueFrom: { fieldRef: { fieldPath: metadata.annotations['app/commit'] } }
```

## Delivery options by language

Defaults are identical across server SDKs. Only the browser SDK differs, because a tab is not a
server.

| Concept | Default | .NET | Python | Node.js | Go | Java | Ruby | PHP |
|---|---|---|---|---|---|---|---|---|
| Max buffered entries | 10,000 | `QueueCapacity` | `queue_size` | `queueCapacity` | `QueueCapacity` | `queueCapacity` | `queue_size` | `queueCapacity` |
| Entries per request | 100 | `BatchSize` | `batch_size` | `batchSize` | `BatchSize` | `batchSize` | `batch_size` | `batchSize` |
| Linger before partial flush | 2 s | `FlushInterval` | `flush_interval` | `flushIntervalMs` | `FlushInterval` | `flushInterval` | `flush_interval` | `flushInterval` |
| Retry attempts per batch | 5 | `MaxRetries` | `max_retries` | `maxRetries` | `MaxRetries` | `maxRetries` | `max_retries` | `maxRetries` (2) |
| First retry delay | 500 ms | `RetryBaseDelay` | `retry_base_delay` | `retryBaseDelayMs` | `RetryBaseDelay` | `retryBaseDelay` | `retry_base_delay` | `retryBaseDelay` (250 ms) |
| Retry delay ceiling | 30 s | `RetryMaxDelay` | `retry_max_delay` | `retryMaxDelayMs` | `RetryMaxDelay` | `retryMaxDelay` | `retry_max_delay` | `retryMaxDelay` (2 s) |
| Per-request HTTP timeout | 10 s | `HttpTimeout` | `timeout` | `timeoutMs` | `Timeout` | `timeout` | `timeout` | `timeout`, `connectTimeout` (3 s) |
| Flush budget on shutdown | 5 s | `ShutdownTimeout` | (at exit) | `close(ms)` | `Close(d)` | (at `close()`) | `close(timeout:)` | (at `close()` / shutdown hook) |
| Dropped counter | 0 | `DroppedCount` | `handler.dropped` | `client.dropped` | `client.Dropped()` | `client.dropped()` | `client.dropped` | `$client->dropped()` |

Browser defaults: 1,000-event buffer, 20 events per request, 3 s linger, 2 retries.

PHP has no background thread, so its client buffers in memory and sends synchronously when the
buffer reaches `batchSize`, when the oldest entry is older than `flushInterval` at the next
`log()`, on `flush()`, or at shutdown (under PHP-FPM that is after the response has been sent when
`fastcgi_finish_request()` was called, as Laravel and Symfony do); its retry defaults are therefore
tighter (2 retries, 0.25 s base, 2 s ceiling). See [PHP](php.md#how-delivery-works-in-php).

## Enrichment options by language

| Concept | .NET | Python | Node.js | Go | Java | Ruby | PHP |
|---|---|---|---|---|---|---|---|
| Service name | `Source` | `source` | `source` | `Source` | `source` | `source` | `source` |
| Release | `Release` | `release` | `release` | `Release` | `release` | `release` | `release` |
| Commit SHA | `CommitSha` | `commit_sha` | `commitSha` | `CommitSha` | `commitSha` | `commit_sha` | `commitSha` |
| Environment | (from host env) | `environment` | `environment` | `Environment` | `environment` | `environment` | `environment` |
| Tags on every entry | `Tags` | `tags` | `tags` | `Tags` | `tags` | `tags` | `tags` |

## Tuning guidance

The defaults suit a normal web service. Change them when your shape differs:

- **High-volume services** (thousands of events per second): raise `BatchSize` to 500 and
  `QueueCapacity` to 50,000 before you touch anything else. Bigger batches cost fewer requests.
- **Short-lived processes** (CLI tools, cron jobs, serverless functions): drop the linger to
  200-500 ms and always close explicitly. A 2 s linger on a 300 ms function means the batch never
  ships.
- **Memory-constrained containers**: lower `QueueCapacity`. Each buffered entry is a small object,
  but 10,000 of them with large stack traces is not free. Dropping is by design and counted.
- **Flaky networks**: raise `MaxRetries` and `RetryMaxDelay`. The queue absorbs the backlog while
  retries proceed, and drops only when it fills.
- **Noisy debug logs**: filter at the logging framework level (log level, category filters) rather
  than at the SDK. Anything the SDK accepts counts toward your quota.

## Turning ZipLogger off

Do not conditionally wrap your logging calls. Configure the logging framework instead:

- Leave the endpoint or key unset in local development and register the handler only when both are
  present. The .NET metrics package already no-ops when unconfigured.
- In tests, add no ZipLogger provider at all, or point it at a local stub server.
- To stop shipping without a redeploy, revoke the key in **Settings → API keys**. Ingestion then
  answers `401`, batches are dropped immediately without retries, and the application keeps
  running normally.

## What counts toward your quota

Logs and spans are metered together. Request metrics are not metered as logs. AI requests are
metered separately per plan. See [pricing](https://ziplogger.ai/pricing.html) for current limits.
