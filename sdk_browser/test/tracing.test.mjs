// Event ↔ request correlation through instrumentFetch().
//
// instrumentFetch() only does anything when a `window` exists, and the SDK decides that once at
// module load, so this file builds a minimal browser-like global BEFORE importing the SDK — which
// is also why it is a separate file from client.test.mjs (same module cache, different globals).
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const listeners = new Map()
globalThis.window = globalThis
globalThis.window.location = { href: 'http://127.0.0.1/app', origin: 'http://127.0.0.1', hostname: '127.0.0.1', pathname: '/app' }
globalThis.window.addEventListener = (name, fn) => listeners.set(name, fn)
globalThis.window.removeEventListener = (name) => listeners.delete(name)
globalThis.document = { addEventListener: () => {}, visibilityState: 'visible' }
// Node ≥ 21 ships a getter-only `navigator`; redefine rather than assign.
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node-test' }, configurable: true })

const { ZipLoggerBrowser } = await import('../index.js')

// Two servers on purpose: ZipLogger ingest on one origin, the app's own API on another. Requests
// to the ingest origin are never instrumented (the SDK does not trace its own shipping), so the
// API has to live elsewhere for propagation to happen — exactly as in a real deployment.
let ingest, api, requests, apiRequests, originalFetch

beforeEach(async () => {
  requests = []
  apiRequests = []
  originalFetch = globalThis.fetch
  ingest = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      requests.push({ path: req.url, lines: body.split('\n').filter(Boolean).map((l) => JSON.parse(l)) })
      res.statusCode = 202
      res.end()
    })
  })
  api = http.createServer((req, res) => {
    apiRequests.push({ path: req.url, traceparent: req.headers.traceparent })
    res.statusCode = req.url.includes('fail') ? 500 : 200
    res.end('{}')
  })
  await Promise.all([
    new Promise((resolve) => ingest.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => api.listen(0, '127.0.0.1', resolve)),
  ])
})

afterEach(() => {
  globalThis.fetch = originalFetch          // instrumentFetch replaced window.fetch (= globalThis.fetch)
  ingest.close()
  api.close()
})

const ingestOrigin = () => `http://127.0.0.1:${ingest.address().port}`
const origin = () => `http://127.0.0.1:${api.address().port}`
const makeClient = (overrides = {}) => new ZipLoggerBrowser({
  endpoint: ingestOrigin(),
  apiKey: 'zk_test',
  flushIntervalMs: 30,
  retryBaseDelayMs: 10,
  ...overrides,
})
const events = () => requests.filter((r) => r.path.includes('/events')).flatMap((r) => r.lines)
const traceIdOf = (traceparent) => traceparent.split('-')[1]

test('track without any instrumented fetch carries no requestId', async () => {
  const c = makeClient()
  c.track('button_clicked', { button: 'signup' })
  await c.flush()

  const e = events()[0]
  assert.equal(e.name, 'button_clicked')
  assert.equal(e.properties.button, 'signup')
  assert.equal(e.requestId, undefined)
  assert.ok(!('requestId' in e), 'no requestId key at all: one is never invented')
  await c.close()
})

test('instrumentFetch followed by track links the event to that request', async () => {
  const c = makeClient()
  // The API is a different origin from the page, so it is named in propagateTo, the way a
  // cross-origin API is configured in a real app.
  const stop = c.instrumentFetch({ propagateTo: [origin()], sendSpans: false })

  await fetch(`${origin()}/api/checkout`, { method: 'POST' })
  c.track('checkout_completed', { amount: 99 })
  await c.flush()

  assert.equal(apiRequests.length, 1)
  assert.match(apiRequests[0].traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/, 'traceparent still propagated')
  const e = events().find((x) => x.name === 'checkout_completed')
  assert.equal(e.requestId, traceIdOf(apiRequests[0].traceparent))
  stop()
  await c.close()
})

test('after the correlation TTL the request is no longer inferred', async () => {
  const c = makeClient({ requestCorrelationTtlMs: 40 })
  const stop = c.instrumentFetch({ propagateTo: [origin()], sendSpans: false })

  await fetch(`${origin()}/api/data`)
  await new Promise((r) => setTimeout(r, 80))
  c.track('viewed_later')
  await c.flush()

  assert.equal(events().find((x) => x.name === 'viewed_later').requestId, undefined)
  stop()
  await c.close()
})

test('an explicit requestId is used as given', async () => {
  const c = makeClient()
  c.track('event', {}, { requestId: 'explicit-request-id' })
  await c.flush()

  assert.equal(events()[0].requestId, 'explicit-request-id')
  await c.close()
})

test('an explicit requestId overrides the inferred one', async () => {
  const c = makeClient()
  const stop = c.instrumentFetch({ propagateTo: [origin()], sendSpans: false })

  await fetch(`${origin()}/api/data`)
  c.track('pinned', {}, { requestId: 'explicit-request-id' })
  c.track('inferred')
  await c.flush()

  const all = events()
  assert.equal(all.find((x) => x.name === 'pinned').requestId, 'explicit-request-id')
  assert.equal(all.find((x) => x.name === 'inferred').requestId, traceIdOf(apiRequests[0].traceparent))
  stop()
  await c.close()
})

test('with several instrumented fetches the most recent one wins', async () => {
  const c = makeClient()
  const stop = c.instrumentFetch({ propagateTo: [origin()], sendSpans: false })

  await fetch(`${origin()}/api/first`)
  await fetch(`${origin()}/api/second`)
  await Promise.all([fetch(`${origin()}/api/third`), fetch(`${origin()}/api/fourth`)])
  c.track('after_many')
  await c.flush()

  const byPath = Object.fromEntries(apiRequests.map((r) => [r.path, traceIdOf(r.traceparent)]))
  const got = events().find((x) => x.name === 'after_many').requestId
  assert.ok([byPath['/api/third'], byPath['/api/fourth']].includes(got), 'one of the two most recent (concurrent) requests')
  assert.notEqual(got, byPath['/api/first'])
  assert.notEqual(got, byPath['/api/second'])
  stop()
  await c.close()
})

test('the SDK’s own telemetry shipping is never the correlated request', async () => {
  const c = makeClient()
  const stop = c.instrumentFetch({ propagateTo: [ingestOrigin()], sendSpans: false })   // even when named, the ingest origin is excluded

  c.log({ severity: 'info', message: 'ship me' })
  await c.flush()                                          // POSTs to /ingest/v1/logs through window.fetch
  c.track('after_shipping')
  await c.flush()

  assert.equal(events().find((x) => x.name === 'after_shipping').requestId, undefined)
  stop()
  await c.close()
})

test('instrumentFetch still logs failed requests with the trace id and stop() ends propagation', async () => {
  const c = makeClient()
  const stop = c.instrumentFetch({ propagateTo: [origin()], sendSpans: false })

  const res = await fetch(`${origin()}/api/fail`)
  assert.equal(res.status, 500)
  stop()
  await fetch(`${origin()}/api/after-stop`)
  c.track('after_stop')
  await c.close()

  assert.match(apiRequests[0].traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  assert.equal(apiRequests[1].traceparent, undefined, 'no traceparent once instrumentation is stopped')
  const failure = requests.filter((r) => r.path.includes('/logs')).flatMap((r) => r.lines).find((l) => /HTTP 500/.test(l.message))
  assert.ok(failure, 'the failed request was logged')
  assert.equal(failure.fields.traceId, traceIdOf(apiRequests[0].traceparent))
  assert.equal(failure.severity, 'error')
  // The un-instrumented request after stop() established no trace id, so the failed one (still
  // inside the TTL) remains the most recent instrumented request.
  assert.equal(events().find((x) => x.name === 'after_stop').requestId, traceIdOf(apiRequests[0].traceparent))
})

test('requestCorrelationTtlMs: 0 turns inference off but keeps explicit ids', async () => {
  const c = makeClient({ requestCorrelationTtlMs: 0 })
  const stop = c.instrumentFetch({ propagateTo: [origin()], sendSpans: false })

  await fetch(`${origin()}/api/data`)
  c.track('not_linked')
  c.track('linked', {}, { requestId: 'abc' })
  await c.flush()

  assert.equal(events().find((x) => x.name === 'not_linked').requestId, undefined)
  assert.equal(events().find((x) => x.name === 'linked').requestId, 'abc')
  stop()
  await c.close()
})
