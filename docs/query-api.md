# Query API

Reading data back out is a different API from sending it in. Ingestion uses an `X-Api-Key`;
everything else uses a JWT, the same credential the web app uses.

Reach for this when you want telemetry inside something else: a status page, a release-quality
gate in CI, a weekly digest, a custom dashboard. For interactive debugging from an AI assistant,
the [MCP server](mcp.md) is the better door, since it needs no token juggling.

## Authentication

Two credential types, used for different things:

| Credential | Used for | How |
|---|---|---|
| API key (`zk_...`) | Log, metric, and OTLP ingestion | `X-Api-Key` header |
| JWT | Everything else: search, traces, metrics, dashboards, billing | `Authorization: Bearer <token>` |

```bash
curl -X POST https://app.ziplogger.ai/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@company.com","password":"..."}'
```

```json
{
  "accessToken": "eyJ...",
  "accessTokenExpires": "2026-08-25T12:30:00Z",
  "refreshToken": "...",
  "user": { "email": "you@company.com", "roles": ["Admin"], "tenantSlug": "acme", "tenantName": "Acme" }
}
```

Access tokens are short-lived. Exchange the refresh token when one expires:

```bash
curl -X POST https://app.ziplogger.ai/api/v1/auth/refresh \
  -H "Content-Type: application/json" -d '{"refreshToken":"..."}'
```

`POST /api/v1/auth/logout` invalidates a refresh token. `GET /api/v1/auth/me` returns the current
user. For an unattended script, use a dedicated account with the narrowest role that works, and
refresh rather than logging in on every run.

## Logs

### Search

```
GET /api/v1/logs/search?q=payment+failed&severity=error&from=2026-08-01T00:00:00Z&size=100
Authorization: Bearer <jwt>
```

| Parameter | Notes |
|---|---|
| `q` | Query string, same syntax as the Search page. Empty matches everything. |
| `from`, `to` | ISO-8601 bounds. |
| `size` | Hits per page, default 100. |
| `after` | Opaque cursor from a previous response's `nextAfter`. |
| `severity`, `source`, `release`, `commitSha`, `templateHash` | Exact-match filters. |

```json
{
  "total": 1483,
  "hits": [ { "id": "...", "timestamp": "...", "severity": "error", "message": "...",
              "source": "checkout-api", "release": "2026.08.22-133", "commitSha": "9f2c...",
              "stackTrace": "...", "fields": { "orderId": 83112 }, "tags": [] } ],
  "nextAfter": "eyJzb3J0IjpbMTc..."
}
```

Paginate by passing `nextAfter` back as `after` until it comes back null. Do not paginate by
incrementing an offset; there is no offset parameter, deliberately, because deep offset paging over
a live index gets slower and less accurate the further you go.

```bash
# Page through an entire day
AFTER=""
while : ; do
  RESP=$(curl -sG https://app.ziplogger.ai/api/v1/logs/search \
    -H "Authorization: Bearer $JWT" \
    --data-urlencode "severity=error" \
    --data-urlencode "from=2026-08-24T00:00:00Z" \
    --data-urlencode "to=2026-08-25T00:00:00Z" \
    --data-urlencode "size=500" ${AFTER:+--data-urlencode "after=$AFTER"})
  echo "$RESP" | jq -c '.hits[]'
  AFTER=$(echo "$RESP" | jq -r '.nextAfter // empty')
  [ -z "$AFTER" ] && break
done
```

### Histogram

```
GET /api/v1/logs/histogram?q=&severity=error&from=...&to=...&interval=5m
```

Returns time buckets as `[{ "time": "...", "count": 42 }]`. Omit `interval` to let the server pick
one from the range.

### Terms

```
GET /api/v1/logs/terms?field=source&from=...&to=...&size=10
```

Returns `{ "field": "source", "buckets": [{ "key": "checkout-api", "count": 9231 }] }`. Useful for
building facet lists ("which services are erroring?") without pulling the events themselves.

### Patterns

```
GET /api/v1/templates?q=&severity=error&from=...&to=...
```

Clusters recent messages into templates with counts, which is the fastest way to answer "what is
breaking" rather than "what happened at 14:03". Clustering runs over a bounded sample of up to
5,000 recent events per request, so treat it as a ranking, not a census.

### Deleting

```
DELETE /api/v1/logs/{id}
POST   /api/v1/logs/delete-by-query     {"q":"...","severity":"debug","from":"...","to":"..."}
```

Admin or Editor roles only, and every deletion is written to the audit log. Both return
`{"deleted": N}`.

## Traces

```
GET /api/v1/traces?from=...&to=...&service=orders-api&errorsOnly=true&size=25&page=0
GET /api/v1/traces/{traceId}
GET /api/v1/traces/services
GET /api/v1/traces/daily-stats?service=orders-api&name=&days=14
```

- The list defaults to the last 24 hours, `size` is clamped to 1-200, and paging is by `page`
  number. It returns `{ traces, total, page, size }`.
- A single trace returns `{ traceId, spans, truncated }`, capped at 1,000 spans.
- `daily-stats` reads daily rollups (`day`, `service`, `name`, `spanCount`, `avgMs`, `p95Ms`,
  `errorCount`) that outlive raw spans, which is what makes day-over-day comparison possible after
  the cleanup of error-free traces (up to 30 days). Pass an empty `name` for the whole-service rollup.

## Metrics

```
GET /api/v1/metrics/services?from=...&to=...
GET /api/v1/metrics/series?service=orders-api&name=request.duration&interval=5m&from=...&to=...
```

Series returns `{ "interval": "5m", "buckets": [{ "time": "...", "avg": 142.7, "p95": 512.3, "count": 8241 }] }`.
See [metrics](metrics.md) for how to get data in.

## Releases

```
GET /api/v1/releases?source=orders-api
```

Every release observed for the workspace, registered automatically at ingestion, newest first (up
to 200): `source`, `name`, `commitSha`, `firstSeenAt`, `lastSeenAt`. `firstSeenAt` is effectively
the deploy time, which makes this the cheapest way to correlate an error spike with a rollout.

## Events

Product-analytics events share the same auth. Every query below accepts the same filters:
`from`/`to` (at most 31 days), `name`, `service`, `environment`, `release`, `country`,
`deviceType`, `browser`, `os`, `userId`, `cohort`, repeated `prop=key:op:value`
(`eq neq contains startsWith endsWith gt gte lt lte`) and repeated `excludeEvent=`.

### Search

```bash
curl -s "https://app.ziplogger.ai/api/v1/events/?name=order_placed&prop=plan:eq:pro&size=100" \
  -H "Authorization: Bearer $TOKEN"
# { "total": 1287, "hits": [ ... ], "nextAfter": "..." }   -- pass nextAfter back as `after` to page
```

### Property schema

Every custom property the workspace has ever sent, with the type the index inferred. Read from
the mapping, so it is complete and cheap.

```bash
curl -s https://app.ziplogger.ai/api/v1/events/properties/keys -H "Authorization: Bearer $TOKEN"
# [ { "key": "beta", "type": "boolean" }, { "key": "plan", "type": "string" }, { "key": "seats", "type": "number" } ]
```

`type` is `string`, `number`, `boolean`, `date`, `mixed` (sent as different types on different
days — showable, not aggregatable) or `other`. A nested object or array is stored as one JSON
string and listed as a `string` property; send dimensions flat (`cartTotal: 12`, not
`cart: { total: 12 }`) if you want to filter or aggregate on them.

### Property values

Top values of one property under the current filters, for building a filter UI.

```bash
curl -s "https://app.ziplogger.ai/api/v1/events/properties/values?property=plan&size=20&from=2026-08-01T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"
# { "field": "plan", "buckets": [ { "key": "pro", "count": 812 }, { "key": "free", "count": 475 } ] }
```

A `mixed` property, or a string without a keyword sub-field, answers 400 with the reason.

### Export

The result set as CSV, with exactly the columns named, in that order. Columns are any built-in
field (`name timestamp userId anonymousId sessionId requestId service environment release
commitSha url page country region city deviceType browser os id`) or `properties.<key>`.

```bash
curl -s "https://app.ziplogger.ai/api/v1/events/export.csv?columns=timestamp,name,userId,properties.plan&name=order_placed" \
  -H "Authorization: Bearer $TOKEN" -o events.csv
```

Capped at 10,000 rows and 40 columns. Values that a spreadsheet would execute as a formula
(`=`, `+`, `-`, `@` prefixes) are neutralised with a leading apostrophe; plain numbers are left
alone.

## Other endpoint groups

`/api/v1/dashboards`, `/api/v1/alerts`, `/api/v1/regressions`, and `/api/v1/billing` follow the
same JWT convention. They back the app's own pages, so the shapes track the UI.

## A worked example: a release-quality gate

```bash
#!/usr/bin/env bash
# Fail a deploy if the new release logged errors in its first 10 minutes.
set -euo pipefail

JWT=$(curl -s -X POST https://app.ziplogger.ai/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ZL_EMAIL\",\"password\":\"$ZL_PASSWORD\"}" | jq -r .accessToken)

ERRORS=$(curl -sG https://app.ziplogger.ai/api/v1/logs/search \
  -H "Authorization: Bearer $JWT" \
  --data-urlencode "release=$GITHUB_REF_NAME" \
  --data-urlencode "severity=error" \
  --data-urlencode "size=1" | jq -r .total)

echo "Errors for release $GITHUB_REF_NAME: $ERRORS"
[ "$ERRORS" -eq 0 ] || { echo "New release is logging errors, rolling back."; exit 1; }
```

This works because the SDKs stamp `release` on every entry automatically. See the
[configuration reference](configuration.md#environment-variables) for wiring it in CI.

## Limits

- API requests are metered per day per plan (5,000 on Free, rising with the plan). See
  [pricing](https://ziplogger.ai/pricing.html).
- Everything is scoped to the workspace in the token. There is no cross-workspace query.
- Search covers your plan's retention window. Older data is gone, not merely hidden.
- Reads consume API requests, not log quota.
