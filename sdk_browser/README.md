# @ziplogger/browser

Browser SDK for [ZipLogger](https://ziplogger.ai) — product-analytics events,
uncaught errors, unhandled promise rejections and distributed tracing from web apps, with a
first-class React error boundary. Zero dependencies.

```bash
npm install @ziplogger/browser
```

## Quick start

```js
import { ZipLoggerBrowser } from '@ziplogger/browser'

export const ziplogger = new ZipLoggerBrowser({
  endpoint: 'https://app.ziplogger.ai',
  apiKey: 'zk_...',            // use a key dedicated to browser traffic
  release: import.meta.env.VITE_APP_VERSION,
})

ziplogger.captureGlobalErrors()  // window.onerror + unhandledrejection

ziplogger.log({ severity: 'info', message: 'checkout started', fields: { cartValue: 214.9 } })
try { risky() } catch (err) { ziplogger.captureError(err, { step: 'payment' }) }
```

## Events

Events are what people did; logs are what you read when something breaks. They are separate calls
because ZipLogger answers different questions with each.

```js
ziplogger.track('checkout_started', { cartValue: 214.9, currency: 'USD' })

// After sign-in. Links everything this browser did anonymously to the account, so the visitor
// stops being counted as two people.
ziplogger.identify('user_42')

ziplogger.reset()   // on sign-out: a fresh anonymous identity from here
```

An un-identified visitor still needs an id, or the server has nobody to attribute the event to. The
SDK mints one on first use and keeps it in `localStorage` (`zl_anon`), with a per-tab session id in
`sessionStorage` (`zl_sess`) — that stored anonymous id is exactly what `identify()` later links.
Both fall back to memory when storage is unavailable, so private mode degrades to per-page
attribution rather than an error.

Every event carries an `insertId`, so a retry after a timeout cannot count it twice.

### Linking events to requests

With `instrumentFetch()` on, every same-origin request (and any origin in `propagateTo`) carries
a W3C `traceparent` header, and the event you track right after it carries that request's trace
id as `requestId`. ZipLogger then shows the logs and traces of the request the event happened in
("Requests sampled", "Errors on these requests" on the event page).

```js
ziplogger.instrumentFetch({ propagateTo: ['https://api.example.com'] })

const res = await fetch('/api/checkout', { method: 'POST', body })
ziplogger.track('checkout_completed', { amount: 99 })   // requestId = that request's trace id
```

Inference uses the most recent instrumented fetch within `requestCorrelationTtlMs` (default 5 s,
a constructor option; 0 disables it). An event with no recent request carries no `requestId` —
one is never invented. To pin an event to a specific request yourself, pass its trace id (or the
full `traceparent` value) explicitly; it wins over the inferred one:

```js
ziplogger.track('checkout_completed', { amount: 99 }, { requestId: traceId })
```

**Do not put credentials in properties.** Values that look like tokens, keys or card numbers are
redacted server-side, but the safe habit is not to send them.

Every event carries `url`, `userAgent`, and `environment` fields automatically; `Error` objects
map to ZipLogger's `stackTrace`. A final `fetch(…, { keepalive: true })` flush fires on
`pagehide` so events survive navigation and tab closes.

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
const { captureError } = useZipLogger()
```

Render errors ship with the component stack; the factory pattern (`createErrorBoundary(React, …)`)
keeps this package free of a React dependency, so it works with any React ≥ 16.8 — and the core
client works with Vue, Svelte, Angular, or no framework at all.

## Session replay

```bash
npm install @rrweb/record        # optional peer dependency; only if you want replay
```

```js
import { attachSessionReplay } from '@ziplogger/browser/replay'

const ziplogger = new ZipLoggerBrowser({
  endpoint: 'https://app.ziplogger.ai',
  apiKey: 'zk_...',
  sessionReplay: { enabled: true, sampleRate: 0.1 },   // record 10% of sessions
})
attachSessionReplay(ziplogger)

ziplogger.sessionReplay.isRecording()
```

Records the DOM, not video, and attaches to the same session id your events and errors carry.
Passwords, payment fields and one-time codes are always masked, every other input is masked by
default, and `data-ziplogger-mask` / `data-ziplogger-ignore` mark up anything else — in the
browser, before it is sent. The recorder is loaded only for visitors who are sampled in: a page
that does not record replays ships the same bytes it always did.

See [docs/session-replay.md](https://github.com/ziploggerhq/ZipLogger_Client/blob/main/docs/session-replay.md).

## Notes

- Browser API keys are visible to users by design (like every client-side telemetry key). Use a
  dedicated key so it can be revoked independently, and rely on your plan's rate limits.
- Batching defaults are browser-tuned: 20 events/request, 3s linger, 2 retries, 1,000-event buffer.
