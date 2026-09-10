# HTTP ingestion API

Anything that can POST JSON can ingest directly. Authentication is a per-workspace ingestion key
(create one under **Settings → API keys**), sent as the `X-Api-Key` header.

Use this API when no SDK fits: a language without one, a database trigger, a CI step, an embedded
device, or a shipper you configure by hand.

## Endpoint

```
POST https://app.ziplogger.ai/ingest/v1/logs
X-Api-Key: zk_...
Content-Type: application/json      (or application/x-ndjson)
```

Accepts a **single object**, a **JSON array**, or **NDJSON** (one JSON object per line, which is
what the official SDKs send).

```bash
curl -X POST https://app.ziplogger.ai/ingest/v1/logs \
  -H "X-Api-Key: zk_..." \
  -H "Content-Type: application/json" \
  -d '{"message":"hello","severity":"info","source":"cron-job"}'
```

A batch as an array:

```bash
curl -X POST https://app.ziplogger.ai/ingest/v1/logs \
  -H "X-Api-Key: zk_..." -H "Content-Type: application/json" \
  -d '[{"message":"first","severity":"info"},{"message":"second","severity":"warn"}]'
```

The same batch as NDJSON:

```bash
printf '%s\n' \
  '{"message":"first","severity":"info"}' \
  '{"message":"second","severity":"warn"}' \
| curl -X POST https://app.ziplogger.ai/ingest/v1/logs \
    -H "X-Api-Key: zk_..." -H "Content-Type: application/x-ndjson" --data-binary @-
```

> **Send compact JSON.** A payload that starts with `{` and contains a newline is parsed as NDJSON,
> so a pretty-printed single object fails with `400`. Either send it on one line, or wrap it in an
> array, which is parsed as JSON whatever the whitespace.

## Entry fields

| Field | Type | Notes |
|---|---|---|
| `message` | string | The log line. Defaults to an empty string, so always send it. |
| `timestamp` | ISO-8601 string | Defaults to receive time. Historical values are accepted and land in their own time buckets. |
| `severity` | string | `debug`, `info` (default), `warn`, `error`, `fatal`. |
| `source` | string | Service or app name, drives filtering and dashboards. |
| `release` | string | Version of the running build. |
| `commitSha` | string | Git commit of the running build, powers regression attribution. |
| `stackTrace` | string | Exception stack trace, feeds "which commit broke this?" analysis. |
| `fields` | object | Arbitrary key/values, all searchable (for example `orderId`, `traceId`). |
| `tags` | string[] | Free-form labels. |

Unknown keys are ignored, so shippers can pass extra metadata harmlessly.

### Severity handling

Severity is normalized, never rejected:

- `warning` is accepted as an alias for `warn`.
- Matching is case-insensitive, so `ERROR` and `error` are the same.
- Any value ZipLogger does not recognize (including `trace` and `critical`) silently becomes
  `info`. If a query for `severity=error` comes back empty, check the spelling you are sending.

### Conventional field names

`fields` is free-form, but a few names light up features elsewhere in the product:

| Field | Effect |
|---|---|
| `fields.traceId` | Adds a **View trace** link from the log line to the trace waterfall. See [tracing](tracing.md). |
| `fields.spanId` | Pins the log to a specific span within that trace. |
| `fields.environment` | Used as the environment facet when it is not set by enrichment. |
| `fields.machineName` | Host or pod that produced the entry. |
| `fields.exceptionType`, `fields.exceptionMessage` | Shown alongside `stackTrace` in error detail. |
| `fields.category` | Logger name, as the SDKs send it. |

Field values may be strings, numbers, booleans, arrays, or nested objects. They are unwrapped to
real types on the way in, so numeric fields stay numeric and remain usable in range queries.

## Responses

| Status | Meaning |
|---|---|
| `202` | Accepted into the ingestion pipeline. |
| `400` | Invalid JSON, or a payload containing no entries. |
| `401` | Missing or invalid `X-Api-Key`. |
| `415` | Unsupported content type (OTLP endpoints only). |
| `429` | A daily or monthly quota is exhausted, or the pipeline is applying backpressure. Retry after the `Retry-After` header (seconds). |

Both `202` and `429` return the same body, so you can always see where you stand:

```json
{
  "accepted": 100,
  "rejected": 0,
  "quota": {
    "dailyLimit": 25000,
    "usedToday": 8412,
    "monthlyLimit": 750000,
    "usedThisMonth": 191203
  },
  "error": null
}
```

A partially accepted batch answers `429` with `accepted` greater than zero and `rejected` counting
the remainder, plus `error` naming which limit was hit. Resend only the rejected tail, or let an
SDK handle it for you.

## Writing your own client

If you are integrating a language without an SDK, mirror what the official ones do:

1. **Never block the caller.** Push onto a bounded in-memory queue and ship from a background
   worker or timer.
2. **Batch.** 100 entries per request as NDJSON is a good default, with a 2 s linger so partial
   batches still ship promptly.
3. **Retry transient failures only.** Retry `408`, `429`, and `5xx` plus network errors, with
   exponential backoff and jitter. Honor `Retry-After` on `429`. Drop immediately on `400` and
   `401`, since retrying a malformed payload or a revoked key never succeeds.
4. **Drop, never grow.** When the queue is full, discard and count. Counting matters: expose the
   counter so operators can see loss.
5. **Enrich once.** Resolve `source`, `release`, `commitSha`, and `environment` at startup rather
   than per entry. See the [configuration reference](configuration.md) for the environment
   variables to read.
6. **Flush on shutdown**, bounded by a timeout so a hung network cannot delay exit.

## Other ingestion endpoints

| Endpoint | Purpose |
|---|---|
| `POST /ingest/v1/logs` | This page. |
| `POST /ingest/v1/metrics` | Request and custom metrics, see [metrics](metrics.md). |
| `POST /v1/logs` | OTLP/HTTP logs, see [OpenTelemetry](opentelemetry.md). |
| `POST /v1/traces` | OTLP/HTTP traces, see [tracing](tracing.md). |

To read data back out, see the [query API](query-api.md).

## Quotas

Paid plans are sold by **daily ingest volume**: 1 GB a day on Pro, 3 GB on Team, 10 GB on Business, covering logs and traces together and measured on the payload you send. There is no overage, so exceeding the day's volume pauses ingestion rather than adding to your invoice. The Free plan is count-based instead: 1,000 log lines a day and 30,000 a month.

Either way an exhausted quota answers `429` with a `Retry-After` header pointing at the next UTC midnight, plus a JSON body showing current usage. Official SDKs honor it automatically, so your application is never blocked by an exhausted quota.

See [pricing](https://ziplogger.ai/pricing.html) for plan limits.

## Troubleshooting

| Symptom | Check |
|---|---|
| `401` on every request | The header is `X-Api-Key`, not `Authorization`, and the key has not been revoked. |
| `400 Invalid JSON` | Pretty-printed single object (see the note above), or a trailing comma. |
| `400 No log entries in payload` | Empty body, or an empty array. |
| `202` but nothing in Search | Check the time range in the UI. An entry with a stale or future `timestamp` lands in that bucket, not "now". |
| Fields not searchable | They must be inside `fields`, not at the top level. Unknown top-level keys are dropped. |
| `severity` filter finds nothing | Unrecognized severities become `info`. See severity handling above. |
