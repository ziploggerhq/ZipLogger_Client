# Distributed tracing

ZipLogger accepts OpenTelemetry traces on the standard OTLP/HTTP path, authenticated with the same
ingestion key as logs. No collector is required: point your service's exporter straight at
ZipLogger and the Traces page shows the waterfall.

Tracing answers a different question from logging. A log line tells you something failed; a trace
tells you where the request was when it failed and what it was waiting on.

## Endpoint

```
POST https://app.ziplogger.ai/v1/traces
POST https://app.ziplogger.ai/ingest/v1/otlp/traces     (alias)
X-Api-Key: zk_...
Content-Type: application/x-protobuf   (or application/json)
```

Both accept a standard `ExportTraceServiceRequest`, optionally gzip-encoded. Any OTel SDK or
Collector can export to it.

## Point an OTel SDK at ZipLogger

The exporter appends `/v1/traces` to the endpoint itself, so give it the origin only:

```bash
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=https://app.ziplogger.ai
OTEL_EXPORTER_OTLP_HEADERS=X-Api-Key=zk_...
OTEL_SERVICE_NAME=orders-api
OTEL_RESOURCE_ATTRIBUTES=service.version=2026.8.1,deployment.environment=production
```

That is the whole integration for any language with OTel auto-instrumentation. A few concrete
starting points:

```bash
# .NET
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol
dotnet add package OpenTelemetry.Instrumentation.AspNetCore
dotnet add package OpenTelemetry.Instrumentation.Http
```

```csharp
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("orders-api", serviceVersion: "2026.8.1"))
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter());   // reads the OTEL_* variables above
```

```bash
# Python (no code change needed)
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install
opentelemetry-instrument python manage.py runserver
```

```bash
# Node.js
npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
            @opentelemetry/exporter-trace-otlp-proto
node --require @opentelemetry/auto-instrumentations-node/register app.js
```

```bash
# Java (agent, no code change)
java -javaagent:opentelemetry-javaagent.jar -jar app.jar
```

Go has no auto-instrumentation agent, so wire the OTLP trace exporter and the `otelhttp` or
`otelgin` middleware in code, then keep using the ZipLogger `slog` handler for logs.

## Or via the OTel Collector

```yaml
exporters:
  otlphttp/ziplogger:
    logs_endpoint: https://app.ziplogger.ai/v1/logs
    traces_endpoint: https://app.ziplogger.ai/v1/traces
    headers: { X-Api-Key: "zk_..." }
    compression: gzip

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/ziplogger]
    logs:
      receivers: [otlp]
      exporters: [otlphttp/ziplogger]
```

## How OTLP spans map

| OTLP | ZipLogger |
|---|---|
| `traceId` / `spanId` / `parentSpanId` | same, as lowercase hex |
| `name` | span name, the operation shown in the waterfall |
| resource `service.name` | `service`, the color band in the waterfall (`unknown` when absent) |
| `kind` | `server`, `client`, `producer`, `consumer`, or `internal` |
| `startTimeUnixNano`, `endTimeUnixNano` | `timestamp` and `durationMs` (rounded to 3 decimals) |
| `status.code` | `ok`, `error`, or `unset`; error spans are red in the waterfall |
| `status.message` | `statusMessage` |
| resource attributes plus span attributes | merged into the span's `attributes`, all filterable |
| `exception.*` attributes on `exception` span events | lifted onto the span, so the stack trace shows in the waterfall |

Span attributes are the searchable dimensions on the Traces page, and the ones traffic alert rules
can filter on (method, route, status code, user agent, and anything else you set).

**Self-telemetry is dropped.** If your HTTP-client instrumentation traces its own calls to
ZipLogger, those client spans are noise about the act of shipping telemetry. Client spans whose
`url.full` points at the ZipLogger host are discarded on arrival, so your waterfalls stay clean.

## Correlating logs with traces

This is the payoff, and it takes one field. Put the active trace id into your log fields:

```csharp
// .NET: Activity.Current is set by ASP.NET Core instrumentation
using (logger.BeginScope(new Dictionary<string, object>
       { ["traceId"] = Activity.Current?.TraceId.ToString() ?? "" }))
{
    logger.LogError(ex, "Payment failed");
}
```

```python
from opentelemetry import trace
ctx = trace.get_current_span().get_span_context()
log.error("Payment failed", extra={"traceId": format(ctx.trace_id, "032x")})
```

```js
const { trace } = require('@opentelemetry/api')
const ctx = trace.getActiveSpan()?.spanContext()
logger.error({ traceId: ctx?.traceId }, 'Payment failed')
```

```go
sc := trace.SpanContextFromContext(ctx)
logger.Error("payment failed", "err", err, "traceId", sc.TraceID().String())
```

Any log carrying `fields.traceId` gets a **View trace** link, so you go from the error line to the
full request flow that produced it in one click. `fields.spanId` narrows it to the exact operation.

## Browser to backend, one trace

The browser SDK can start the trace in the user's tab, so the waterfall begins where the click did:

```js
ziplogger.instrumentFetch({ propagateTo: ['https://api.yourcompany.com'] })
```

This wraps `fetch`, adds a W3C `traceparent` header so your instrumented backend continues the
same trace, exports a browser-side root span, and logs failed requests with the trace id. See the
[browser guide](browser.md#frontend-to-backend-tracing) for the details and the CORS requirement.

## What tracing unlocks

- **Waterfall view.** Every operation a request triggered, nested under its parent, colored by
  service, with durations and error spans in red, and each span's attributes one click away.
- **Trace list.** Filter recent requests by service, time window, or errors only.
- **Latency alerts.** A rule can fire when an operation's p95 latency rises a chosen percentage
  above its own 24-hour baseline, per service or per route. See [alerts](alerts-webhooks.md).
- **Traffic anomaly alerts.** Absolute caps ("more than 500 requests to `/api/orders` in a
  minute") or relative ones ("3x normal traffic"), narrowed by any span attribute.
- **Day-over-day comparison.** Daily latency rollups are kept separately from raw spans, so
  comparisons keep working after the spans themselves age out.

## Quotas and retention

- **Spans count toward your plan's log quota.** Chatty auto-instrumentation can consume it fast, so
  sample at the SDK if you are near a limit.
- When the quota is exhausted, the receiver answers `429` with `Retry-After`. Exporters retry per
  their own policy.
- Partial success is reported per the OTLP spec: HTTP 200 with `partialSuccess.rejectedSpans`
  (protobuf) or `{"partialSuccess":{"rejectedSpans":N}}` (JSON).
- **Traces containing an error span are kept for your plan's full retention. Error-free traces are
  kept for up to 30 days, never longer than your plan's retention.** Traces exist to debug failures, and keeping every healthy request
  for a month buys nothing.
- Reading a single trace returns at most 1,000 spans, with a `truncated` flag when it hits the cap.

## Sampling

ZipLogger has no server-side sampling, because the SDK is the right place for it: a span you never
export costs nothing. Use the standard OTel knobs.

```bash
# keep 10% of traces, plus everything a parent already sampled
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

Sample the same way in every service of a request path. Mixed rates produce traces with holes in
them.

## Troubleshooting

| Symptom | Check |
|---|---|
| No traces at all | The exporter endpoint is the **origin** (`https://app.ziplogger.ai`); the SDK appends `/v1/traces`. Setting the full path yields `/v1/traces/v1/traces`. |
| `401` | The key travels as `OTEL_EXPORTER_OTLP_HEADERS=X-Api-Key=zk_...`, with no `Bearer` prefix. |
| `415` | Content type must be `application/x-protobuf` or `application/json`. |
| Service shows as `unknown` | Set `OTEL_SERVICE_NAME` or the `service.name` resource attribute. |
| Spans arrive but never nest | Context is not propagating. Confirm every hop passes `traceparent` and that your framework's instrumentation is registered. |
| Trace not found when opening a link | Error-free traces are pruned after your workspace's window (up to 30 days), so old links to healthy traces expire. |
| Quota burning faster than before | Auto-instrumentation spans are metered as logs. Turn down the sampler. |
