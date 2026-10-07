import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { ZipLoggerBrowser } from '../index.js'

let server, requests, responses

beforeEach(async () => {
  requests = []
  responses = []
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const status = responses.length ? responses.shift() : 202
      requests.push({
        path: req.url,
        apiKey: req.headers['x-api-key'],
        lines: body.split('\n').filter(Boolean).map((l) => JSON.parse(l)),
        status,
      })
      if (status === 429) res.setHeader('Retry-After', '0')
      res.statusCode = status
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterEach(() => server.close())

const makeClient = (overrides = {}) => new ZipLoggerBrowser({
  endpoint: `http://127.0.0.1:${server.address().port}`,
  apiKey: 'zk_test',
  flushIntervalMs: 30,
  retryBaseDelayMs: 10,
  ...overrides,
})

const waitFor = (predicate, timeout = 5000) => new Promise((resolve, reject) => {
  const start = Date.now()
  const timer = setInterval(() => {
    if (predicate()) { clearInterval(timer); resolve() }
    else if (Date.now() - start > timeout) { clearInterval(timer); reject(new Error('timeout')) }
  }, 10)
})

test('batches NDJSON with api key and defaults', async () => {
  const client = makeClient({ source: 'webapp', release: '2.0.0' })
  for (let i = 0; i < 3; i++) client.log({ severity: 'info', message: `event ${i}`, fields: { i } })
  await client.close()

  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/ingest/v1/logs')
  assert.equal(requests[0].apiKey, 'zk_test')
  const first = requests[0].lines[0]
  assert.equal(first.source, 'webapp')
  assert.equal(first.release, '2.0.0')
  assert.equal(first.fields.environment, 'production')
})

test('feedback requires explicit consent, has session identity and never infers a recent request', async () => {
  const client = makeClient({ sessionId: 'feedback-session', release: 'feedback-release' })
  client._lastRequest = { traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', at: Date.now() }
  assert.equal(client.submitFeedback('Please help', { hasConsent: false }), false)
  assert.equal(client.submitFeedback('  Checkout did not finish  ', { hasConsent: true,
    issueId: 'DA79B670-BD78-4A56-AF25-1893EFC05257' }), true)
  await client.close()
  const entry = requests[0].lines[0]
  assert.equal(entry.name, 'user_feedback'); assert.equal(entry.sessionId, 'feedback-session')
  assert.equal(entry.requestId, undefined); assert.equal(entry.url, undefined)
  assert.equal(entry.properties.issueId, 'da79b670-bd78-4a56-af25-1893efc05257')
  assert.equal(entry.properties.message, 'Checkout did not finish')
})

test('captureError maps stack and fields', async () => {
  const client = makeClient()
  client.captureError(new RangeError('too far'), { step: 'checkout' })
  await client.close()

  const entry = requests[0].lines[0]
  assert.equal(entry.severity, 'error')
  assert.equal(entry.message, 'too far')
  assert.match(entry.stackTrace, /RangeError: too far/)
  assert.equal(entry.fields.exceptionType, 'RangeError')
  assert.equal(entry.fields.step, 'checkout')
})

test('retries on 429 then succeeds', async () => {
  responses = [429, 202]
  const client = makeClient()
  client.log({ severity: 'info', message: 'retry me' })
  await waitFor(() => requests.length >= 2)
  await client.close()
  assert.equal(client.dropped, 0)
})

test('drops after browser-tuned max retries', async () => {
  responses = [500, 500, 500]
  const client = makeClient({ maxRetries: 2 })
  client.log({ severity: 'info', message: 'doomed' })
  await waitFor(() => client.dropped >= 1)
  assert.equal(requests.length, 3)
  await client.close()
})

test('queue overflow drops instead of blocking', async () => {
  const client = makeClient({ queueCapacity: 2, flushIntervalMs: 60_000 })
  for (let i = 0; i < 20; i++) client.log({ severity: 'info', message: `burst ${i}` })
  assert.ok(client.dropped >= 18)
  await client.close()
})

test('keepalive flush sends without retrying', async () => {
  responses = [500]
  const client = makeClient()
  client.log({ severity: 'info', message: 'unloading' })
  await client.flush(true)
  assert.equal(requests.length, 1) // no retries during unload
  assert.equal(client.dropped, 1)
})

test('react error boundary factory logs render errors', async () => {
  const { createErrorBoundary } = await import('../react.js')
  const client = makeClient()

  // Minimal React stand-in: the factory only needs Component with setState-free lifecycle.
  const FakeReact = { Component: class { constructor(props) { this.props = props } } }
  const Boundary = createErrorBoundary(FakeReact, client)
  const boundary = new Boundary({ name: 'AppShell' })
  boundary.componentDidCatch(new Error('render exploded'), { componentStack: '\n  at App\n  at Root' })
  await client.close()

  const entry = requests[0].lines[0]
  assert.match(entry.message, /render exploded/)
  assert.match(entry.fields.componentStack, /at App/)
  assert.equal(entry.fields.boundary, 'AppShell')
})

// ---- product-analytics events ---------------------------------------------------------------
// Events are a different endpoint with a different payload, so the things worth pinning are that
// they go to the right place, that they always carry an identity (the server rejects events
// without one), and that identify() links rather than merely switching ids.

test('track posts to the events endpoint, not the logs endpoint', async () => {
  const c = makeClient()
  c.track('checkout_started', { amount: 99 })
  await c.flush()

  const req = requests.find((r) => r.path.includes('/events'))
  assert.ok(req, 'expected a request to /ingest/v1/events')
  assert.equal(req.lines.length, 1)
  assert.equal(req.lines[0].name, 'checkout_started')
  assert.equal(req.lines[0].type, 'track')
  assert.equal(req.lines[0].properties.amount, 99)
  assert.equal(req.apiKey, 'zk_test')
  await c.close()
})

test('every event carries an identity, because the server rejects events without one', async () => {
  const c = makeClient()
  c.track('page_viewed')
  await c.flush()

  const e = requests.find((r) => r.path.includes('/events')).lines[0]
  assert.ok(e.anonymousId, 'an un-identified visitor still needs an anonymous id')
  assert.ok(e.sessionId, 'events should group into a session')
  assert.equal(e.userId, undefined)
  await c.close()
})

test('an event carries an insertId so a retry cannot count it twice', async () => {
  const c = makeClient()
  c.track('a')
  c.track('b')
  await c.flush()

  const lines = requests.find((r) => r.path.includes('/events')).lines
  assert.ok(lines[0].insertId && lines[1].insertId)
  assert.notEqual(lines[0].insertId, lines[1].insertId)
  await c.close()
})

test('identify links the anonymous id and stamps later events with the user', async () => {
  const c = makeClient()
  const anon = c.identity.anonymousId

  c.track('viewed_pricing')      // anonymous
  c.identify('user_42')
  c.track('subscribed')          // identified
  await c.flush()

  const lines = requests.filter((r) => r.path.includes('/events')).flatMap((r) => r.lines)
  const identify = lines.find((l) => l.type === 'identify')
  assert.ok(identify, 'expected an identify call')
  assert.equal(identify.userId, 'user_42')
  assert.equal(identify.anonymousId, anon, 'must link the SAME anonymous id the events used')

  const after = lines.find((l) => l.name === 'subscribed')
  assert.equal(after.userId, 'user_42')
  assert.equal(after.anonymousId, anon, 'the anonymous id stays, so the server can stitch either way')
  await c.close()
})

test('reset makes later events a different anonymous person', async () => {
  const c = makeClient()
  c.identify('user_42')
  const before = c.identity.anonymousId
  c.reset()

  assert.equal(c.identity.userId, null)
  assert.notEqual(c.identity.anonymousId, before)
  await c.close()
})

test('track ignores a missing or non-string name instead of sending rubbish', async () => {
  const c = makeClient()
  c.track()
  c.track('')
  c.track({ name: 'nope' })
  await c.flush()

  assert.equal(requests.filter((r) => r.path.includes('/events')).length, 0)
  await c.close()
})

test('events and logs are queued and flushed independently', async () => {
  const c = makeClient()
  c.log({ message: 'a log line', severity: 'info' })
  c.track('an_event')
  await c.flush()

  const paths = requests.map((r) => r.path)
  assert.ok(paths.some((p) => p.includes('/ingest/v1/logs')), 'logs still go to /logs')
  assert.ok(paths.some((p) => p.includes('/ingest/v1/events')), 'events go to /events')
  await c.close()
})

test('a server rejection drops events rather than retrying forever', async () => {
  responses = [400]
  const c = makeClient({ maxRetries: 1 })
  c.track('doomed')
  await c.flush()

  assert.equal(c.dropped, 1, 'a 4xx is not retryable, so the event is counted as dropped')
  await c.close()
})

test('the event queue is bounded like the log queue', async () => {
  const c = makeClient({ queueCapacity: 3, flushIntervalMs: 10_000 })
  for (let i = 0; i < 10; i++) c.track(`e${i}`)

  assert.equal(c.dropped, 7, 'over capacity, events are dropped rather than growing without limit')
  await c.close()
})

test('an explicit userId is used from the start, with no identify call needed', async () => {
  const c = makeClient({ userId: 'user_known' })
  c.track('server_rendered_page')
  await c.flush()

  const e = requests.find((r) => r.path.includes('/events')).lines[0]
  assert.equal(e.userId, 'user_known')
  await c.close()
})
