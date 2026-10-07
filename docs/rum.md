# Browser measurements and feedback

Implemented locally, 2026-10-07; the SDK changes are not yet published. Core browser
collection has no dependencies; this optional entry requires `web-vitals` 6.2.3.

```js
import { attachRum } from '@ziplogger/browser/rum'
const rum = attachRum(ziplogger, {
  enabled: true,
  hasConsent: false,
  sampleRate: 1,
  getRoute: () => '/checkout', // application's static route template, never customer IDs
  frustration: false,
  maxEventsPerPage: 100,
})
// Connect these calls to your application's consent controls.
rum.setConsent(true)
rum.setConsent(false)
```

Defaults: disabled, no consent, sampling 1, no frustration collection, 100 queued
observations per page (configurable 1–1000). Sampling is deterministic by session.
Invalid sampling rates disable collection. LCP and INP are milliseconds; CLS is a
unitless score. Hard document visits are measured; SPA route transitions are not
independent Web Vital visits. Missing measurements are unknown. The RUM screen
computes observed distributions from at most 1,000 retained events and labels
truncation. Sampled visits never represent the full visitor population.

RUM events include session/user identity, configured release/environment and the
static route. They omit raw URLs, element text and selectors. Opaque observation
IDs and insert IDs stay stable across a metric update; server event deduplication
prevents separate retained rows, while normal ingress billing still applies.

Revocation purges queued RUM events and suppresses later callbacks. It cannot
recall an in-flight request. Independently configured analytics, error collection,
identity storage and replay have their own policies: RUM consent does not govern
them. To revoke replay, also call `replay.stop({ discard: true })`. Instantiate
the core client only when its identity storage and collection are permitted.
`rum.stop()` detaches subscribers and listeners; Google's shared observers cannot
be disposed through its public API, and later callbacks are consent-gated.
Metrics describe the full document visit and can use buffered entries predating
consent. Regrant may report earlier interactions from the same visit. Consent
gates initialization and emission; it does not redefine Web Vitals' measurement
window. For stricter consent-window requirements, start on a fresh document after
consent. Replay discard permanently invalidates queued uploads across regrant;
an old failed request cannot retry discarded data or remove a new queued chunk.

Frustration is opt-in. Mark a static label with `data-ziplogger-action="submit"`.
Rage clicks require three trusted clicks on that target within 40 px and 1 second.
Dead clicks additionally require `data-ziplogger-dead-click` and no observed DOM
mutation, instrumented fetch start or navigation for 1 second. Call
`rum.notifyActivity()` for application activity the SDK cannot see. These are
heuristics, not proof of user intent or failure; form inputs and disabled controls
are excluded.

```js
ziplogger.submitFeedback('Checkout did not work', {
  hasConsent: true,
  issueId: '00000000-0000-0000-0000-000000000001',
})
```

Feedback requires explicit consent even when RUM is disabled. Messages are trimmed
to 2,000 characters. A valid issue UUID is a user-supplied association, not proof
of causation. Feedback uses existing event identity, authorization, privacy
scrubbing, quota, retention and billing. A true return value means queued locally,
not acknowledged by the server. Do not put credentials or sensitive data in text.

Browser-inferred recent request IDs are marked `zlRequestRelation=recent_request`;
explicit options are marked `explicit`. Investigations display inference as such;
Process Reports exclude inferred IDs from explicit request-error counts. Older
SDK data lacks this marker and cannot be retrospectively classified reliably.

Validate with `npm test` in `sdk_browser`. Server setup, real-browser fixture,
bounded-distribution definitions, CI source maps and remaining acceptance gaps
are maintained in ZipLogger's `docs/RUM.md` and `docs/ERROR-TRACKING.md`.
