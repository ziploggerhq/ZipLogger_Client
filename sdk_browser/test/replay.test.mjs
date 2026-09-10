// Session Replay: sampling, the server handshake, chunking, idempotent retries, privacy options,
// and — the property everything else depends on — that nothing in replay can break the page or the
// rest of the SDK.
//
// Like tracing.test.mjs this builds a browser-shaped global BEFORE importing the SDK, because the
// SDK decides once at module load whether it has a window. rrweb itself is never loaded here: a
// fake recorder stands in, so the tests exercise our code and not the DOM serialiser.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'

const windowListeners = new Map()
const documentListeners = new Map()
const storage = new Map()
globalThis.window = globalThis
globalThis.window.location = { href: 'http://127.0.0.1/app', origin: 'http://127.0.0.1', hostname: '127.0.0.1', pathname: '/app' }
globalThis.window.innerWidth = 1280
globalThis.window.innerHeight = 720
globalThis.window.addEventListener = (name, fn) => windowListeners.set(name, fn)
globalThis.window.removeEventListener = (name) => windowListeners.delete(name)
globalThis.document = {
  addEventListener: (name, fn) => documentListeners.set(name, fn),
  removeEventListener: (name) => documentListeners.delete(name),
  visibilityState: 'visible',
}
globalThis.sessionStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
}
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node-test' }, configurable: true })

const { ZipLoggerBrowser } = await import('../index.js')
const { attachSessionReplay, sampledIn, fnv1a, ALWAYS_MASK_SELECTORS, ALWAYS_BLOCK_SELECTORS, REPLAY_SDK_VERSION } = await import('../replay.js')
const { version: PACKAGE_VERSION } = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile(new URL('../package.json', import.meta.url), 'utf8')))

let server, chunks, logs, configResponses, chunkResponses, configRequests

beforeEach(async () => {
  chunks = []
  logs = []
  configRequests = 0
  configResponses = []
  chunkResponses = []
  storage.clear()
  windowListeners.clear()
  documentListeners.clear()
  server = http.createServer((req, res) => {
    const parts = []
    req.on('data', (c) => parts.push(c))
    req.on('end', () => {
      let body = Buffer.concat(parts)
      if (req.method === 'GET' && req.url === '/ingest/v1/replay/config') {
        configRequests++
        const cfg = configResponses.length ? configResponses.shift() : { enabled: true, flushIntervalMs: 20 }
        res.setHeader('Content-Type', 'application/json')
        res.statusCode = cfg.status ?? 200
        res.end(JSON.stringify(cfg))
        return
      }
      if (req.url === '/ingest/v1/replay') {
        if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body)
        const status = chunkResponses.length ? chunkResponses.shift() : 202
        chunks.push({ status, encoding: req.headers['content-encoding'], apiKey: req.headers['x-api-key'], payload: JSON.parse(body.toString()) })
        if (status === 429) res.setHeader('Retry-After', '0')
        res.statusCode = status
        res.end('{}')
        return
      }
      if (req.url === '/ingest/v1/logs') {
        logs.push(...body.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
      }
      res.statusCode = 202
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
})

/**
 * Attach a controller whose network dies with the test that created it.
 *
 * Without this, a recorder left running by one test can upload to the *next* test's server — the
 * OS re-binds the same ephemeral port often enough for it to matter — where it consumes the
 * queued status code that test was relying on. So every controller gets its fetch wrapped in a
 * liveness guard that `afterEach` flips off before the server closes.
 */
const attached = []
const attach = (client, deps = {}) => {
  const inner = deps.fetch ?? ((url, init) => fetch(url, init))
  const guard = { live: true }
  const dead = () => Promise.resolve({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({}) })
  const controller = attachSessionReplay(client, {
    ...deps,
    fetch: (url, init) => (guard.live ? inner(url, init) : dead()),
  })
  attached.push({ controller, guard })
  return controller
}

/** Only the chunks this client uploaded. Guards against cross-talk if a port is re-bound. */
const chunksOf = (client) => chunks.filter((c) => c.payload.sessionId === client.identity.sessionId)

afterEach(() => {
  // Cut the network first, then stop the recorders without waiting for their final chunk: that
  // upload is aimed at a server about to close, and waiting for it would mean sitting through the
  // retry ladder once per leaked controller.
  for (const { controller, guard } of attached.splice(0)) {
    guard.live = false
    try { void controller.stop() } catch { /* the test may have already stopped it */ }
  }
  server.close()
})

const origin = () => `http://127.0.0.1:${server.address().port}`

const makeClient = (replay = { enabled: true }, overrides = {}) => new ZipLoggerBrowser({
  endpoint: origin(),
  apiKey: 'zk_test',
  flushIntervalMs: 20,
  retryBaseDelayMs: 5,
  // `null` means "a client that never configured replay at all", which is the default a customer
  // upgrading the package gets.
  ...(replay ? { sessionReplay: replay } : {}),
  ...overrides,
})

/** A stand-in for rrweb's record(): remembers its options, exposes emit, emits Meta + FullSnapshot. */
function fakeRecorder() {
  const state = { options: null, stopped: 0, emit: null, loads: 0 }
  const record = (options) => {
    state.options = options
    state.emit = options.emit
    options.emit({ type: 4, timestamp: Date.now(), data: { href: 'http://127.0.0.1/app', width: 1280, height: 720 } })
    options.emit({ type: 2, timestamp: Date.now(), data: { node: { type: 0, childNodes: [], id: 1 }, initialOffset: { top: 0, left: 0 } } })
    return () => { state.stopped++ }
  }
  state.load = async () => { state.loads++; return record }
  state.mutation = (n = 1) => {
    for (let i = 0; i < n; i++)
      state.emit({ type: 3, timestamp: Date.now(), data: { source: 0, adds: [], removes: [], texts: [{ id: 5, value: `t${i}` }], attributes: [] } })
  }
  return state
}

// Generous by default: a test that waits on the *outcome* of an upload can be waiting through the
// retry ladder (1 s, then 4 s) if the first attempt to a freshly bound localhost port is dropped,
// which happens occasionally on Windows. The retries are the behaviour under test elsewhere; here
// they must not turn a correct SDK into a flaky suite.
const waitFor = (predicate, timeout = 15000) => new Promise((resolve, reject) => {
  const start = Date.now()
  const timer = setInterval(() => {
    if (predicate()) { clearInterval(timer); resolve() }
    else if (Date.now() - start > timeout) { clearInterval(timer); reject(new Error('timeout')) }
  }, 5)
})

// ---- opt-in and the server handshake ----------------------------------------------------------

test('a client without sessionReplay never contacts the server or loads a recorder', async () => {
  const rec = fakeRecorder()
  const client = makeClient(null)
  const controller = attach(client, { loadRecorder: rec.load, compress: null })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(controller.isRecording(), false)
  assert.equal(rec.loads, 0)
  assert.equal(configRequests, 0)
  assert.equal(chunks.length, 0)
})

test('the version reported on the wire is the package version', () => {
  // Pinned to package.json rather than to a literal: a release bumps one place, and a chunk that
  // claims the wrong SDK version makes every support conversation harder.
  assert.equal(REPLAY_SDK_VERSION, PACKAGE_VERSION)
})

test('the core controller is inert and typed the same before attach', () => {
  const client = makeClient()
  assert.equal(client.sessionReplay.isRecording(), false)
  assert.ok(client.sessionReplay.start() instanceof Promise)
})

test('asks the server first and records nothing when it says enabled:false', async () => {
  configResponses = [{ enabled: false, reason: 'replay_not_in_plan' }]
  const rec = fakeRecorder()
  const client = makeClient()
  const controller = attach(client, { loadRecorder: rec.load, compress: null })
  await controller.start()
  assert.equal(configRequests, 1)
  assert.equal(rec.loads, 0)
  assert.equal(controller.isRecording(), false)
  assert.equal(controller.lastReason, 'replay_not_in_plan')
})

test('an unreachable configuration endpoint means no recording, not a guess', async () => {
  configResponses = [{ status: 404 }]
  const rec = fakeRecorder()
  const controller = attach(makeClient(), { loadRecorder: rec.load, compress: null })
  await controller.start()
  assert.equal(rec.loads, 0)
  assert.equal(controller.lastReason, 'unreachable')
})

// ---- sampling ---------------------------------------------------------------------------------

test('sampling is deterministic on the session id', () => {
  assert.equal(fnv1a('sess_abc'), fnv1a('sess_abc'))
  assert.equal(sampledIn('sess_abc', 0), false)
  assert.equal(sampledIn('sess_abc', 1), true)
  const at50 = sampledIn('sess_abc', 0.5)
  for (let i = 0; i < 10; i++) assert.equal(sampledIn('sess_abc', 0.5), at50)
  // Roughly the right share of ids make it in — including sequential ids, which plain FNV-1a
  // clusters badly enough to skew the rate. This is what the avalanche mix in fnv1a is for.
  for (const rate of [0.1, 0.25, 0.5]) {
    let sequential = 0
    let random = 0
    for (let i = 0; i < 4000; i++) {
      if (sampledIn(`sess_${i}`, rate)) sequential++
      if (sampledIn(`sess_${i.toString(16)}${(i * 2654435761 >>> 0).toString(16)}`, rate)) random++
    }
    const expected = 4000 * rate
    assert.ok(Math.abs(sequential - expected) < expected * 0.15, `sequential ids at ${rate}: ${sequential}, expected ~${expected}`)
    assert.ok(Math.abs(random - expected) < expected * 0.15, `random ids at ${rate}: ${random}, expected ~${expected}`)
  }
})

test('a server sample rate overrides the one in the page', async () => {
  configResponses = [{ enabled: true, sampleRate: 0 }]
  const rec = fakeRecorder()
  const controller = attach(makeClient({ enabled: true, sampleRate: 1 }), { loadRecorder: rec.load, compress: null })
  await controller.start()
  assert.equal(rec.loads, 0)
  assert.equal(controller.lastReason, 'not_sampled')
})

test('the sampling decision is stored so a reload keeps it', async () => {
  configResponses = [{ enabled: true, sampleRate: 0 }]
  const client = makeClient()
  const controller = attach(client, { loadRecorder: fakeRecorder().load, compress: null })
  await controller.start()
  const state = JSON.parse(storage.get('zl_replay'))
  assert.equal(state.sid, client.identity.sessionId)
  assert.equal(state.sampled, false)

  // Same session, "new page": the decision is read back and the server is not even asked.
  const again = attach(makeClient({ enabled: true }, { sessionId: client.identity.sessionId }), { loadRecorder: fakeRecorder().load, compress: null })
  await again.start()
  assert.equal(configRequests, 1)
  assert.equal(again.lastReason, 'not_sampled')
})

// ---- chunks -----------------------------------------------------------------------------------

test('chunk 0 carries Meta and FullSnapshot, and sequence numbers climb by one', async () => {
  const rec = fakeRecorder()
  const client = makeClient()
  const controller = attach(client, { loadRecorder: rec.load, compress: null })
  await controller.start()
  assert.equal(controller.isRecording(), true)

  await waitFor(() => chunks.length >= 1)
  const first = chunks[0].payload
  assert.equal(first.sessionId, client.identity.sessionId)
  assert.equal(first.sequence, 0)
  assert.equal(first.events[0].type, 4)
  assert.equal(first.events[1].type, 2)
  assert.equal(first.meta.final, false)
  assert.equal(first.meta.url, 'http://127.0.0.1/app')
  assert.equal(first.meta.sdk, REPLAY_SDK_VERSION)
  assert.equal(chunks[0].apiKey, 'zk_test')

  rec.mutation(3)
  await waitFor(() => chunks.length >= 2)
  assert.equal(chunks[1].payload.sequence, 1)
  assert.equal(chunks[1].payload.events.length, 3)
})

test('a full buffer is uploaded without waiting for the timer', async () => {
  const rec = fakeRecorder()
  const controller = attach(makeClient({ enabled: true, flushEvents: 10, flushIntervalMs: 60_000 }), { loadRecorder: rec.load, compress: null })
  configResponses = []
  await controller.start()
  rec.mutation(8)   // 2 initial + 8 = 10
  await waitFor(() => chunks.length >= 1)
  assert.equal(chunks[0].payload.events.length, 10)
})

test('uploads are gzipped with CompressionStream when it exists', async () => {
  assert.ok(typeof CompressionStream !== 'undefined', 'this Node has CompressionStream')
  const rec = fakeRecorder()
  const controller = attach(makeClient(), { loadRecorder: rec.load })
  await controller.start()
  await waitFor(() => chunks.length >= 1)
  assert.equal(chunks[0].encoding, 'gzip')
  assert.equal(chunks[0].payload.sequence, 0)
})

test('a failed upload is retried with the same sequence number', async () => {
  chunkResponses = [500, 202]
  const rec = fakeRecorder()
  const controller = attach(makeClient(), { loadRecorder: rec.load, compress: null })
  await controller.start()
  await waitFor(() => chunks.length >= 2, 8000)
  assert.equal(chunks[0].status, 500)
  assert.equal(chunks[0].payload.sequence, 0)
  assert.equal(chunks[1].payload.sequence, 0)
  assert.deepEqual(chunks[1].payload.events, chunks[0].payload.events)
})

test('a 409 means another tab owns the session: this one stops', async () => {
  chunkResponses = [409]
  const rec = fakeRecorder()
  const controller = attach(makeClient(), { loadRecorder: rec.load, compress: null })
  await controller.start()
  await waitFor(() => controller.isRecording() === false)
  assert.equal(controller.lastReason, 'sequence_conflict')
  assert.equal(rec.stopped, 1)
})

test('a 403 (workspace switched replay off) stops the recorder', async () => {
  chunkResponses = [403]
  const rec = fakeRecorder()
  const controller = attach(makeClient(), { loadRecorder: rec.load, compress: null })
  await controller.start()
  await waitFor(() => controller.isRecording() === false)
  assert.equal(controller.lastReason, 'disabled')
})

test('the sequence continues where a previous page left it', async () => {
  const client = makeClient()
  storage.set('zl_replay', JSON.stringify({ sid: client.identity.sessionId, sampled: true, seq: 7 }))
  const rec = fakeRecorder()
  const controller = attach(client, { loadRecorder: rec.load, compress: null })
  await controller.start()
  await waitFor(() => chunksOf(client).length >= 1)
  const first = chunksOf(client)[0]
  assert.equal(first.payload.sequence, 7)
  assert.equal(first.payload.events[1].type, 2, 'a new page starts with its own snapshot')
})

test('when uploads stall, recording stops instead of growing the backlog', async () => {
  const rec = fakeRecorder()
  const never = () => new Promise(() => {})
  const controller = attach(makeClient({ enabled: true, flushEvents: 2, maxPendingChunks: 3 }), {
    loadRecorder: rec.load, compress: null,
    fetch: (url, init) => init && init.method === 'POST' ? never() : fetch(url, init),
  })
  await controller.start()
  for (let i = 0; i < 12; i++) rec.mutation(2)
  assert.equal(controller.isRecording(), false)
  assert.equal(controller.lastReason, 'upload_backlog')
  assert.ok(controller.dropped > 0)
})

// ---- stop / start / limits ---------------------------------------------------------------------

test('stop() sends a final chunk with a stop marker; start() resumes the same session', async () => {
  const rec = fakeRecorder()
  const client = makeClient()
  const controller = attach(client, { loadRecorder: rec.load, compress: null })
  await controller.start()
  await waitFor(() => chunks.length >= 1)
  await controller.stop()
  assert.equal(controller.isRecording(), false)
  assert.equal(rec.stopped, 1)
  const last = chunks[chunks.length - 1].payload
  assert.equal(last.meta.final, true)
  const marker = last.events[last.events.length - 1]
  assert.equal(marker.type, 5)
  assert.equal(marker.data.tag, 'ziplogger.stop')
  assert.equal(marker.data.payload.reason, 'stopped')

  const before = chunks.length
  await controller.start()
  assert.equal(controller.isRecording(), true)
  await waitFor(() => chunks.length > before)
  assert.equal(chunks[before].payload.sessionId, client.identity.sessionId)
  assert.equal(chunks[before].payload.sequence, last.sequence + 1)
})

test('the session length limit ends the recording', async () => {
  let now = 1_000_000
  const rec = fakeRecorder()
  const controller = attach(makeClient({ enabled: true, maxSessionSeconds: 10 }), {
    loadRecorder: rec.load, compress: null, now: () => now,
  })
  await controller.start()
  now += 11_000
  rec.mutation(1)
  assert.equal(controller.isRecording(), false)
  assert.equal(controller.lastReason, 'max_duration')
})

test('reset() (sign-out) ends the recording and starts a new one under the new session id', async () => {
  const rec = fakeRecorder()
  const client = makeClient()
  const controller = attach(client, { loadRecorder: rec.load, compress: null })
  await controller.start()
  const oldSession = client.identity.sessionId
  await waitFor(() => chunks.length >= 1)
  client.reset()
  assert.notEqual(client.identity.sessionId, oldSession)
  await waitFor(() => controller.isRecording() === true)
  await waitFor(() => chunks.some((c) => c.payload.sessionId === client.identity.sessionId))
})

test('stop() called while start() is still in flight prevents recording', async () => {
  // Starting is two awaits deep (config, then the recorder download). Code that starts on mount
  // and stops on an immediate route change must not end up recording the page it left.
  let releaseRecorder
  const gate = new Promise((resolve) => { releaseRecorder = resolve })
  const rec = fakeRecorder()
  const client = makeClient()
  const controller = attach(client, {
    loadRecorder: async () => { await gate; return (await rec.load()) },
    compress: null,
  })

  const starting = controller.start()
  await controller.stop()          // the recorder has not even been handed over yet
  releaseRecorder()
  await starting

  assert.equal(controller.isRecording(), false)
  assert.equal(controller.lastReason, 'stopped')
  assert.equal(rec.options, null, 'the recorder was never started')
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(chunksOf(client), [], 'and nothing was uploaded')
})

test('start() after a stop works again', async () => {
  const rec = fakeRecorder()
  const client = makeClient()
  const controller = attach(client, { loadRecorder: rec.load, compress: null })
  await controller.start()
  await controller.stop()
  assert.equal(controller.isRecording(), false)
  await controller.start()
  assert.equal(controller.isRecording(), true, 'a cancelled start must not poison later ones')
})

// ---- privacy ----------------------------------------------------------------------------------

test('inputs are masked by default and the always-on selectors are present', async () => {
  const rec = fakeRecorder()
  const controller = attach(makeClient(), { loadRecorder: rec.load, compress: null })
  await controller.start()
  const o = rec.options
  assert.equal(o.maskAllInputs, true)
  for (const sel of ALWAYS_MASK_SELECTORS) assert.ok(o.maskTextSelector.includes(sel), sel)
  for (const sel of ALWAYS_BLOCK_SELECTORS) assert.ok(o.blockSelector.includes(sel), sel)
  assert.ok(o.maskTextSelector.includes('[data-ziplogger-mask]'))
  assert.ok(o.blockSelector.includes('[data-ziplogger-ignore]'))
  assert.equal(o.slimDOMOptions, 'all')
  assert.equal(o.recordCanvas, false)
})

test('maskInputs:false still masks passwords and payment fields', async () => {
  const rec = fakeRecorder()
  const controller = attach(makeClient({ enabled: true, maskInputs: false }), { loadRecorder: rec.load, compress: null })
  await controller.start()
  assert.equal(rec.options.maskAllInputs, false)
  assert.deepEqual(rec.options.maskInputOptions, { password: true })
  assert.ok(rec.options.maskTextSelector.includes('input[type="password"]'))
  assert.ok(rec.options.maskTextSelector.includes('input[autocomplete="cc-number"]'))
})

test('the server can tighten masking but the page cannot loosen what the server set', async () => {
  configResponses = [{ enabled: true, maskInputs: true, maskAllText: true }]
  const rec = fakeRecorder()
  const controller = attach(makeClient({ enabled: true, maskInputs: false, maskAllText: false }), { loadRecorder: rec.load, compress: null })
  await controller.start()
  assert.equal(rec.options.maskAllInputs, true)
  assert.ok(rec.options.maskTextSelector.split(',').includes('*'))
})

test('customer selectors are added, never replacing the built-in ones', async () => {
  const rec = fakeRecorder()
  const controller = attach(makeClient({ enabled: true, maskSelector: '.pii', blockSelector: '#chat' }), { loadRecorder: rec.load, compress: null })
  await controller.start()
  assert.ok(rec.options.maskTextSelector.endsWith(',.pii'))
  assert.equal(rec.options.blockSelector, '[data-ziplogger-ignore],#chat')
})

test('the upload URL carries origin and path only, never the query string', async () => {
  globalThis.window.location = { href: 'http://127.0.0.1/reset?token=SECRET', origin: 'http://127.0.0.1', hostname: '127.0.0.1', pathname: '/reset' }
  const rec = fakeRecorder()
  const controller = attach(makeClient(), { loadRecorder: rec.load, compress: null })
  await controller.start()
  await waitFor(() => chunks.length >= 1)
  assert.equal(chunks[0].payload.meta.url, 'http://127.0.0.1/reset')
  assert.ok(!JSON.stringify(chunks[0].payload.meta).includes('SECRET'))
  globalThis.window.location = { href: 'http://127.0.0.1/app', origin: 'http://127.0.0.1', hostname: '127.0.0.1', pathname: '/app' }
})

// ---- correlation ------------------------------------------------------------------------------

test('log lines carry the session id while recording, and stop carrying it afterwards', async () => {
  const rec = fakeRecorder()
  const client = makeClient()
  const controller = attach(client, { loadRecorder: rec.load, compress: null })
  await controller.start()
  client.log({ severity: 'error', message: 'boom', fields: { step: 'pay' } })
  await client.flush()
  assert.equal(logs[0].fields.sessionId, client.identity.sessionId)
  assert.equal(logs[0].fields.step, 'pay')

  await controller.stop()
  client.log({ severity: 'info', message: 'after' })
  await client.flush()
  assert.equal(logs[1].fields.sessionId, undefined)
})

test('SPA navigation is recorded as a custom event', async () => {
  const rec = fakeRecorder()
  const controller = attach(makeClient(), { loadRecorder: rec.load, compress: null })
  await controller.start()
  await waitFor(() => chunks.length >= 1)
  globalThis.window.location = { href: 'http://127.0.0.1/checkout', origin: 'http://127.0.0.1', hostname: '127.0.0.1', pathname: '/checkout' }
  windowListeners.get('popstate')()
  rec.mutation(1)
  await waitFor(() => chunks.length >= 2)
  const nav = chunks[1].payload.events.find((e) => e.type === 5 && e.data.tag === 'ziplogger.navigation')
  assert.ok(nav, 'navigation marker present')
  assert.equal(nav.data.payload.url, 'http://127.0.0.1/checkout')
  globalThis.window.location = { href: 'http://127.0.0.1/app', origin: 'http://127.0.0.1', hostname: '127.0.0.1', pathname: '/app' }
})

test('hiding the page flushes what is buffered', async () => {
  const rec = fakeRecorder()
  const controller = attach(makeClient({ enabled: true, flushIntervalMs: 60_000 }), { loadRecorder: rec.load, compress: null })
  configResponses = [{ enabled: true }]
  await controller.start()
  assert.equal(chunks.length, 0)
  globalThis.document.visibilityState = 'hidden'
  documentListeners.get('visibilitychange')()
  await waitFor(() => chunks.length >= 1)
  globalThis.document.visibilityState = 'visible'
})

// ---- failure isolation ------------------------------------------------------------------------

test('a recorder that cannot load leaves logging and tracking untouched', async () => {
  const client = makeClient()
  const controller = attach(client, {
    loadRecorder: async () => { throw new Error('CSP blocked the import') },
    compress: null,
  })
  await controller.start()
  assert.equal(controller.isRecording(), false)
  assert.equal(controller.lastReason, 'error')

  client.log({ severity: 'info', message: 'still works' })
  await client.flush()
  assert.equal(logs.length, 1)
  assert.equal(logs[0].message, 'still works')
})

test('a recorder that throws while starting is contained', async () => {
  const client = makeClient()
  const controller = attach(client, {
    loadRecorder: async () => () => { throw new Error('rrweb exploded') },
    compress: null,
  })
  await controller.start()   // does not reject
  assert.equal(controller.isRecording(), false)
  client.track('checkout_started')
  await client.flush()
  assert.equal(client.dropped, 0)
})

test('an exception inside the event path disables replay for the session only', async () => {
  const rec = fakeRecorder()
  const client = makeClient()
  const controller = attach(client, { loadRecorder: rec.load, compress: null })
  await controller.start()
  const poison = {}
  poison.self = poison          // JSON.stringify throws on cycles
  rec.emit({ type: 3, timestamp: Date.now(), data: poison })
  assert.equal(controller.isRecording(), false)
  assert.equal(controller.lastReason, 'error')
  client.log({ severity: 'info', message: 'fine' })
  await client.flush()
  assert.equal(logs.at(-1).message, 'fine')
})
