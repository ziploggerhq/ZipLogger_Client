# Browser / React

Capture uncaught errors, unhandled promise rejections, custom events, and failed network requests
from web apps, with a first-class React error boundary and optional frontend-to-backend tracing.
Zero dependencies.

```bash
npm install @ziplogger/browser
```

## Quick start

```js
import { ZipLoggerBrowser } from '@ziplogger/browser'

export const ziplogger = new ZipLoggerBrowser({
  endpoint: 'https://app.ziplogger.ai',
  apiKey: 'zk_...',            // use a key dedicated to browser traffic
  source: 'storefront',
  release: import.meta.env.VITE_APP_VERSION,
})

ziplogger.captureGlobalErrors()  // window.onerror + unhandledrejection

ziplogger.log({ severity: 'info', message: 'checkout started', fields: { cartValue: 214.9 } })
try { risky() } catch (err) { ziplogger.captureError(err, { step: 'payment' }) }
```

Create the client once in a module and import it everywhere, rather than constructing one per
component. Each instance owns its own queue and flush timer.

Every event carries `url`, `userAgent`, and `environment` fields automatically; `Error` objects map
to ZipLogger's `stackTrace`, `fields.exceptionType`, and `fields.exceptionMessage`. A final
`fetch(…, { keepalive: true })` flush fires on `pagehide`, so events survive navigation and tab
closes.

### What global capture gives you

`captureGlobalErrors()` returns a stop function and attaches two listeners:

| Source | Message | Extra fields |
|---|---|---|
| `window.onerror` | The error message, or `Uncaught error` | `file`, `line`, `column`, `handler: "window.onerror"` |
| `unhandledrejection` | `Unhandled rejection: …` | `handler: "unhandledrejection"` |

Call it once, as early as possible, so errors during startup are not missed.

## Events

Logs are what you read when something breaks. Events are what people did. ZipLogger answers
different questions with each, so they are separate calls.

```js
ziplogger.track('checkout_started', { cartValue: 214.9, currency: 'USD' })
```

### Identity

The server needs somebody to attribute an event to, so an un-identified visitor still gets an id.
The SDK mints one on first use and keeps it in `localStorage` under `zl_anon`, alongside a per-tab
session id in `sessionStorage` under `zl_sess`. Both fall back to memory when storage is blocked,
so a private window degrades to per-page attribution rather than throwing.

After sign-in, link the two:

```js
ziplogger.identify('user_42')
```

That is what stops one person being counted twice — once as the anonymous visitor who read your
pricing page, once as the account that subscribed. Everything they did before signing in joins
their profile. On sign-out, `ziplogger.reset()` starts a fresh anonymous identity so the next
visitor on a shared machine is not attributed to the previous one.

```js
const { userId, anonymousId, sessionId } = ziplogger.identity   // useful when debugging
```

### Delivery

Events use the same machinery as logs: a bounded queue, batches of 20, a 3-second linger, retry
with backoff that honours `Retry-After`, and a `keepalive` flush on `pagehide` so a checkout event
survives the navigation that follows it. They are queued separately from logs and posted to
`/ingest/v1/events`, so a slow log batch never delays an event or the reverse.

Each event carries an `insertId`, so if a request times out and retries, the event is recorded
once rather than twice.

### What not to send

Property values that look like credentials — tokens, keys, card numbers — are redacted
server-side, but the safe habit is not to send them. Event properties are visible to everyone on
your team with access to the Events page.

## Session replay

Watch what a user did before an error — the pages, the cursor, the clicks, which field they
struggled with — rebuilt from the DOM rather than recorded as video.

```bash
npm install @rrweb/record        # optional peer dependency; only for replay
```

```js
import { attachSessionReplay } from '@ziplogger/browser/replay'

const ziplogger = new ZipLoggerBrowser({
  endpoint: 'https://app.ziplogger.ai',
  apiKey: 'zk_...',
  sessionReplay: { enabled: true, sampleRate: 0.1 },
})
attachSessionReplay(ziplogger)
```

Passwords, payment fields and one-time codes are always masked; every other input is masked by
default. `data-ziplogger-mask` masks an element's text and `data-ziplogger-ignore` leaves a subtree
out of the recording entirely — all of it applied in the browser, before anything is sent. The
recorder is fetched only for visitors who are actually sampled in, so a page that does not record
adds nothing but 2.8 KB gzipped.

Full guide, including the privacy rules, sampling, retention and the measured cost:
**[Session replay](session-replay.md)**.

## Frontend-to-backend tracing

The single most useful call in this SDK, and the one people miss:

```js
ziplogger.instrumentFetch()
// or, for APIs on another origin you control:
ziplogger.instrumentFetch({ propagateTo: ['https://api.yourcompany.com'] })
```

This wraps `window.fetch` so that every request to your own backend:

- carries a W3C `traceparent` header, so your OpenTelemetry-instrumented server **continues the
  same trace** rather than starting a new one;
- exports a browser-side root span, so the waterfall starts in the user's browser instead of at
  your load balancer;
- is logged automatically when it fails (HTTP 400 or above, or a network error), with the trace id
  in `fields.traceId`.

The result: a user hits an error, and you go from that log line to the full browser → backend →
database waterfall in one click. See [tracing](tracing.md).

### Options

| Option | Default | Purpose |
|---|---|---|
| `propagateTo` | `[]` | Extra origin prefixes to trace, beyond same-origin |
| `logFailures` | `true` | Log requests that fail with HTTP >= 400 or a network error |
| `sendSpans` | `true` | Export the browser-side root span |
| `serviceName` | `<source>-browser` | Service name for browser spans |

Returns a function that removes the instrumentation.

### Requirements and behavior

- **Same-origin requests are traced by default.** Relative URLs and your own origin need no
  configuration.
- **Cross-origin needs CORS.** Adding a header makes the request non-simple, so the target server
  must allow `traceparent` in `Access-Control-Allow-Headers` (and answer the preflight). Without
  that, requests to `propagateTo` origins will fail, so add the origin only once the server allows
  the header.
- **Telemetry shipping is never traced.** Requests to the ZipLogger origin itself are skipped, so
  you do not get spans about sending spans.
- Browser spans are shipped as OTLP/JSON to `/v1/traces` with the same API key, batched on the same
  linger as logs, with `keepalive` so they survive navigation.
- Third-party requests (analytics, fonts, payment iframes) are left alone: they are not your trace
  and their servers would reject the header.

Spans count toward your plan's log quota, so on a very high-traffic site consider
`{ sendSpans: false }` to keep header propagation and failure logging while leaving span volume to
your backend.

## React

```jsx
import React from 'react'
import { createErrorBoundary, createUseZipLogger } from '@ziplogger/browser/react'
import { ziplogger } from './ziplogger'

const ZipLoggerErrorBoundary = createErrorBoundary(React, ziplogger)
export const useZipLogger = createUseZipLogger(React, ziplogger)

root.render(
  <ZipLoggerErrorBoundary fallback={<p>Something went wrong.</p>}>
    <App />
  </ZipLoggerErrorBoundary>,
)

// in any component
const { captureError, log } = useZipLogger()
```

The boundary accepts `fallback`, `name` (to identify which boundary caught it), and `onError` for
your own side effects:

```jsx
<ZipLoggerErrorBoundary
  name="checkout"
  fallback={<CheckoutFallback />}
  onError={(error, info) => resetCheckoutState()}
>
  <Checkout />
</ZipLoggerErrorBoundary>
```

Wrap several boundaries at meaningful seams rather than one at the root: a boundary around the
cart lets the rest of the page survive, and `name` tells you which part failed.

Render errors ship with the component stack. The factory pattern (`createErrorBoundary(React, …)`)
keeps this package free of a React dependency, so it works with any React 16.8 or newer, and the
core client works with Vue, Svelte, Angular, or no framework at all.

### Other frameworks

```js
// Vue 3
app.config.errorHandler = (err, instance, info) =>
  ziplogger.captureError(err, { vueInfo: info })
```

```js
// Svelte / SvelteKit
export function handleError({ error, event }) {
  ziplogger.captureError(error, { route: event.route?.id })
  return { message: 'Something went wrong.' }
}
```

```ts
// Angular
@Injectable()
export class ZipLoggerErrorHandler implements ErrorHandler {
  handleError(error: unknown) { ziplogger.captureError(error) }
}
```

## Adding context

Fields are what make browser errors actionable. A stack trace from minified code tells you little;
the route, the release, and the user's action tell you a lot.

```js
// on every route change in an SPA
router.afterEach((to) => {
  ziplogger.log({ severity: 'debug', message: 'route change', fields: { route: to.name } })
})

// user actions worth correlating with errors
ziplogger.log({ severity: 'info', message: 'coupon applied',
                fields: { code: coupon, cartValue: total } })
```

Do not log personal data. Browser events are logs like any other: they are searchable by everyone
on your team and retained for your plan's window. Send ids, not names, emails, or card details.

## Releases and stack traces

Set `release` to the same value your backend reports, so a bad deploy shows up as one release
across both:

```js
new ZipLoggerBrowser({
  endpoint: 'https://app.ziplogger.ai',
  apiKey: import.meta.env.VITE_ZIPLOGGER_KEY,
  release: import.meta.env.VITE_APP_VERSION,     // e.g. from package.json or the git tag
  commitSha: import.meta.env.VITE_COMMIT_SHA,    // enables regression attribution
})
```

Bundled stack traces point at minified files. ZipLogger stores the trace as sent, so keep your
source maps where your team can use them, and rely on `commitSha` to line the error up with the
code that produced it.

## Content Security Policy

If you serve a CSP, the browser must be allowed to reach ZipLogger:

```
Content-Security-Policy: connect-src 'self' https://app.ziplogger.ai;
```

Without it, the browser blocks every flush and the console fills with CSP violations rather than
your logs reaching anyone.

## Options

| Option | Default | Purpose |
|---|---|---|
| `endpoint`, `apiKey` | required | Server origin and ingestion key |
| `source` | `window.location.hostname` | Service name |
| `release`, `commitSha` | none | Build identity, powers regression attribution |
| `environment` | `production` | Deployment environment |
| `tags` | none | Tags added to every event |
| `includePageContext` | `true` | Attach `url` and `userAgent` to every event |
| `queueCapacity` | 1000 | Max buffered events |
| `batchSize` | 20 | Events per request |
| `flushIntervalMs` | 3000 | Linger before flushing a partial batch |
| `maxRetries` | 2 | Retry attempts per batch (browsers should not hammer) |
| `retryBaseDelayMs` | 500 | First backoff delay |

Methods: `log(entry)`, `captureError(error, fields?)`, `captureGlobalErrors()`,
`instrumentFetch(options?)`, `flush(keepalive?)`, `close()`, and the `dropped` counter.

Batching defaults are deliberately browser-tuned: smaller batches, a longer linger, and fewer
retries than the server SDKs, because a tab is not a server and should not spend a user's network
on telemetry.

## Notes on API keys and volume

- **Browser API keys are visible to users by design**, like every client-side telemetry key. Use a
  dedicated key so it can be revoked independently, and rely on your plan's rate limits.
- A busy public site can generate far more events than a backend service. Sample noisy,
  non-actionable events yourself before calling `log`:

```js
const sample = (rate) => Math.random() < rate
if (sample(0.05)) ziplogger.log({ severity: 'debug', message: 'carousel viewed' })
// but never sample errors
ziplogger.captureError(err)
```

- Set `queueCapacity` low on pages that can generate error storms (a render loop fills a 1,000-event
  buffer quickly). Dropping is counted in `ziplogger.dropped`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing arrives, CSP errors in console | Add `connect-src https://app.ziplogger.ai`. |
| Nothing arrives on tab close | `flush()` runs on `pagehide`. Some mobile browsers kill tabs without firing it, so a short `flushIntervalMs` loses less. |
| Cross-origin fetches break after `instrumentFetch` | The target server must allow the `traceparent` header in CORS. Remove the origin from `propagateTo` until it does. |
| Traces show only backend spans | `sendSpans` is false, or the browser span was rejected. Check the network tab for the `/v1/traces` call. |
| Backend starts a new trace instead of continuing | Your server is not reading `traceparent`. Confirm OTel instrumentation is registered there. |
| `dropped` climbing | An error loop is filling the buffer. Fix the loop, or raise `queueCapacity`. |
| Stack traces unreadable | Minified bundle. Keep source maps, and set `commitSha` so regression analysis can work from the source. |
