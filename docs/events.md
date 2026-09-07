# Product analytics (Events)

Events are things **users did** — `checkout_started`, `product_viewed`, `signup_completed` — as
opposed to things your code logged. ZipLogger stores them next to your logs and traces and joins
them on the same correlation ids, which is the point: when an error pattern appears, the Search
page can answer *"what were users doing?"* with the actual journey
(`product_viewed → add_to_cart → checkout_started → ❌ error`), the affected users, and where they
are. No second analytics vendor, no id-stitching project.

Events appear in the app under **Events**, and every error pattern in **Search** gets a
*"What were users doing?"* button once events flow.

## Tracking from .NET

`ZipLogger.Client` 0.5.0+ ships an event tracker on the same shipper that carries your logs,
and `ZipLogger.Extensions.Logging` 0.5.0+ registers it, so `IEventTracker` is injectable with
no extra wiring.
If you already use `ZipLogger.Extensions.Logging` or `ZipLogger.Serilog`, there is nothing new to
configure — resolve `IEventTracker` and call it:

```csharp
using ZipLogger.Client;

// anywhere you can resolve services
app.MapPost("/checkout", (Cart cart, IEventTracker analytics) =>
{
    analytics.Track("checkout_started", new
    {
        userId = cart.UserId,     // well-known keys are lifted to first-class fields
        amount = cart.Total,      // everything else becomes a queryable property
        currency = "USD",
        items = cart.Items.Count,
    });
    ...
});
```

`Track` never blocks and never throws: events go onto a bounded in-memory channel and ship in
NDJSON batches in the background, with retry and backoff, exactly like log entries. If the channel
is full or the server keeps refusing, events are dropped and counted on
`IEventTracker.EventsDroppedCount` — your checkout is never the casualty of your analytics.

Well-known keys lifted from the property object: `userId`, `anonymousId`, `sessionId`,
`requestId`, `url`, `page`. You can also pass `userId`/`anonymousId`/`sessionId` as explicit
arguments; explicit arguments win.

### Sessions

A session groups events into one journey. Either pass `sessionId` yourself, or open an ambient
scope and let everything inside it stamp automatically:

```csharp
using (AmbientSession.Begin(sessionId))
{
    analytics.Track("import_started");
    await RunImportAsync();
    analytics.Track("import_finished", new { rows });
}
```

The scope flows across `await` (it is an `AsyncLocal`), so a per-request middleware that calls
`AmbientSession.Begin(...)` gives every event in that request the same session.

### Identity: anonymous → signed in

Before login you only have a client-generated `anonymousId`; after login you have your real user
id. Link them once and the user's profile includes their pre-login events:

```csharp
analytics.Identify(userId: user.Id, anonymousId: request.Cookies["zl_anon"]);
```

Linking is server-side, tenant-scoped, and reversible from the user's profile page in the app
(revoking un-merges; no events are modified or deleted).

### Correlation with logs and traces — the whole point

Every event defaults its `requestId` to `Activity.Current`'s trace id. In an ASP.NET Core app
with tracing enabled that means an event, the request's logs, and its spans all carry the same id,
so the Events UI deep-links to the trace waterfall and error correlation works with zero setup.
Keep tracing on; you get the joins for free.

## Tracking from the browser

`@ziplogger/browser` 0.4.0+ has the same two calls:

```js
ziplogger.track('checkout_started', { cartValue: 214.9 })
ziplogger.identify('user_42')      // after sign-in
```

The SDK holds the `anonymousId` for you — minted on first use and kept in `localStorage` — so
`identify()` links a visitor's pre-login events without you passing an id around. That is the
browser half of the identity flow described above; the .NET example reads the same id out of the
`zl_anon` cookie when your server does the linking instead.

Browser events get their `requestId` from `instrumentFetch()`: from 0.4.1, `track()` carries the
trace id of the most recent instrumented request (within `requestCorrelationTtlMs`, default 5 s),
so the event page can show that request's logs and traces. Pass `{ requestId }` as the third
argument to pin an event to a specific request; without `instrumentFetch()` and without an explicit
id, browser events have no `requestId` and the correlation panel stays empty.

## HTTP API

Anything that can POST JSON can send events. Same authentication as log ingestion
(`X-Api-Key`, an ingestion key from **Settings → API keys**):

```
POST https://app.ziplogger.ai/ingest/v1/events
X-Api-Key: zk_...
Content-Type: application/json      (or application/x-ndjson)
```

Accepts a single object, a JSON array, or NDJSON — the same three shapes as `/ingest/v1/logs`.

```bash
curl -X POST https://app.ziplogger.ai/ingest/v1/events \
  -H "X-Api-Key: zk_..." -H "Content-Type: application/json" \
  -d '{"name":"checkout_started","userId":"u-42","sessionId":"s-1","properties":{"amount":129.9}}'
```

| Field | Meaning |
|---|---|
| `name` | **Required.** Normalized at ingest: lowercased, spaces/dashes → `_`, so `Checkout Started` and `checkout_started` are one event. Max 120 chars. |
| `type` | `track` (default) or `identify`. An identify event links `anonymousId` to `userId`. |
| `timestamp` | ISO-8601. Defaults to arrival time; clamped to at most 5 minutes ahead and 30 days back. |
| `userId` / `anonymousId` / `sessionId` | Identity and journey grouping. Max 200 chars each. |
| `requestId` | W3C trace id (32 hex) or a full `traceparent` header — this is what joins events to logs and traces. |
| `url`, `page` | Where it happened. Query strings and fragments are stripped by default (tokens live there). |
| `service`, `environment`, `release`, `commitSha` | Same enrichment vocabulary as logs. |
| `properties` | Flat object of your own dimensions. Numbers stay numbers (so the app can sum/average them); one level of nesting is flattened to a string. |

Responses mirror log ingestion: `202` with `{accepted, rejected}` counts, `401` for a bad key,
`429` with `Retry-After` when the plan's daily event quota is exhausted. The official SDK backs
off on 429 and drops silently rather than surfacing errors into your app.

## Privacy defaults

- **No raw IPs are ever stored.** If the server is configured with a local GeoIP database, the
  client IP is looked up in-process for an approximate country/city and immediately discarded;
  otherwise events simply have no location. Location is derived per request from the forwarded
  client address, so a server-side SDK that batches events for many end users will attribute all
  of them to the server's own location — send the browser's address through
  `X-Forwarded-For`, or accept that backend-sent events have no useful geography.
- **Location is on events only.** Logs and traces carry no country/city fields.
- **User-Agent strings are not stored** — only the classification (`mobile`, `Chrome`, `Windows`).
- **URLs are stripped of query strings and fragments** before storage by default.
- **Credential-shaped data is redacted at ingest**: property keys containing `password`, `token`,
  `card_number`, etc. become `[redacted]`, and so do values that look like API keys, JWTs, or
  card-length digit runs — even under innocent key names. Don't rely on this as permission to
  send secrets; it is a safety net, not a feature.

## Limits

Daily event caps are per plan (see [pricing](https://ziplogger.ai/pricing.html)); usage and the
day's remaining quota are on the Events page. Past the cap the API answers `429` + `Retry-After`
until the UTC day resets — nothing crashes, and accepted events from a partially-over-quota batch
are kept.
