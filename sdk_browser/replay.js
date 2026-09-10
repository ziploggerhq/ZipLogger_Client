/**
 * Session Replay for @ziplogger/browser — an rrweb recording of what the user saw and did,
 * attached to the same session id the SDK's events and error logs already carry.
 *
 * A separate entry on purpose. The core package stays zero-dependency: this file is the only one
 * that knows rrweb exists, and it loads `@rrweb/record` with a dynamic import at the moment a
 * session is actually sampled in — a visitor who is not recorded never downloads the recorder.
 *
 *   import { ZipLoggerBrowser } from '@ziplogger/browser'
 *   import { attachSessionReplay } from '@ziplogger/browser/replay'
 *
 *   const zl = new ZipLoggerBrowser({
 *     endpoint, apiKey,
 *     sessionReplay: { enabled: true, sampleRate: 0.1, maskInputs: true },
 *   })
 *   attachSessionReplay(zl)          // starts on its own when `enabled`
 *   zl.sessionReplay.isRecording()
 *
 * Before a single event is recorded the SDK asks the server (GET /ingest/v1/replay/config): the
 * workspace's plan, its settings and the platform kill switch all answer there, so recording can
 * be stopped for every visitor without shipping a new build of your app.
 *
 * Everything in here is wrapped: a failure anywhere in replay disables replay for the session and
 * says so once on the console; it never reaches your page or the rest of the SDK.
 */

export const REPLAY_SDK_VERSION = '0.5.0'

const HAS_WINDOW = typeof window !== 'undefined' && typeof document !== 'undefined'

// rrweb event types, by number so @rrweb/types is not needed at runtime.
const EVENT_FULL_SNAPSHOT = 2
const EVENT_META = 4
const EVENT_CUSTOM = 5

/** sessionStorage key holding { sid, sampled, seq }: the sampling decision and the next sequence. */
const STATE_KEY = 'zl_replay'

const DEFAULTS = {
  enabled: false,
  sampleRate: 1,
  maskInputs: true,
  maskAllText: false,
  maskSelector: null,
  blockSelector: null,
  recordCanvas: false,
  maxSessionSeconds: 3600,
  maxSessionBytes: 50_000_000,
  flushIntervalMs: 5_000,
  flushEvents: 100,
  flushBytes: 256 * 1024,
  maxPendingChunks: 8,
}

/**
 * Masked whatever the options say. Passwords and payment fields never leave the browser in
 * clear, and `data-ziplogger-mask` is the customer's own "never record this" marker.
 */
export const ALWAYS_MASK_SELECTORS = [
  '[data-ziplogger-mask]',
  '[data-ziplogger-mask] *',
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  'input[autocomplete="one-time-code"]',
  'input[autocomplete="cc-number"]',
  'input[autocomplete="cc-csc"]',
  'input[autocomplete="cc-exp"]',
  'input[autocomplete="cc-exp-month"]',
  'input[autocomplete="cc-exp-year"]',
  'input[autocomplete="cc-name"]',
]

/** Not recorded at all: the subtree is replaced by an empty box of the same size. */
export const ALWAYS_BLOCK_SELECTORS = ['[data-ziplogger-ignore]']

/**
 * 32-bit FNV-1a with an avalanche finish, so a session id maps to the same number in every
 * browser and every runtime.
 *
 * The final mix is not decoration. Plain FNV-1a leaves neighbouring short strings ("sess_1",
 * "sess_2") clustered, and sampling reads the top of that value — a workspace whose ids are
 * sequential would get noticeably more or less than the rate it asked for. The mix spreads them.
 */
export function fnv1a(str) {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x21f0aaad) >>> 0
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x735a2d97) >>> 0
  return (hash ^ (hash >>> 15)) >>> 0
}

/** Deterministic per session: the same id gives the same answer on every page of the visit. */
export function sampledIn(sessionId, rate) {
  if (!(rate > 0)) return false
  if (rate >= 1) return true
  return fnv1a(String(sessionId)) / 0x100000000 < rate
}

/** gzip with the browser's own CompressionStream; returns the text unchanged where there is none. */
async function gzipText(text) {
  if (typeof CompressionStream === 'undefined') return text
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  if (typeof timer === 'object' && timer.unref) timer.unref()
})

/**
 * Wire Session Replay into a client. Replaces the inert `client.sessionReplay` the core ships
 * with a live controller and, when `sessionReplay.enabled` is set, starts it.
 *
 * @param {import('./index').ZipLoggerBrowser} client
 * @param {import('./index').SessionReplayDependencies} [deps] Test seams: the recorder loader,
 *   fetch and the compressor. Production code passes nothing.
 * @returns {import('./index').SessionReplayController}
 */
export function attachSessionReplay(client, deps = {}) {
  const controller = new SessionReplayController(client, deps)
  client.sessionReplay = controller
  if (controller._options.enabled) void controller.start()
  return controller
}

export class SessionReplayController {
  constructor(client, deps) {
    this._client = client
    this._options = { ...DEFAULTS, ...(client._replayOptions || {}) }
    this._loadRecorder = deps.loadRecorder || (() => import('@rrweb/record').then((m) => m.record))
    this._fetch = deps.fetch || ((url, init) => fetch(url, init))
    this._compress = deps.compress === undefined ? gzipText : deps.compress
    this._now = deps.now || (() => Date.now())

    const origin = client._eventsUrl.replace(/\/ingest\/v1\/events$/i, '')
    this._url = origin + '/ingest/v1/replay'

    this._recording = false
    this._starting = null
    this._stopRecorder = null
    this._recorder = null
    this._sessionId = null
    this._seq = 0
    this._startedAt = 0
    this._bytesSent = 0
    this._recorderErrors = 0
    this._lastHref = null

    this._buffer = []          // JSON strings of events waiting for the next chunk
    this._bufferBytes = 0
    this._pending = []         // chunks waiting to upload, in sequence order
    this._uploading = Promise.resolve()
    this._timer = null
    this._detach = []
    this._unwrapLog = null

    /** Events lost to upload failures or backlog. Mirrors client.dropped for logs. */
    this.dropped = 0
    /** Why recording is not happening, when it is not: not_sampled, disabled, unreachable, ... */
    this.lastReason = null
    /** The server's answer to the last configuration request, for debugging. */
    this.serverConfig = null

    // A sign-out mints a new session id; the old recording ends with it.
    const originalReset = client.reset
    client.reset = () => {
      originalReset.call(client)
      if (this._recording) {
        this._finish('reset')
        if (this._options.enabled) void this.start()
      }
    }
  }

  isRecording() { return this._recording }

  /** Begin recording this session, if the server and the sampling decision allow it. Idempotent. */
  start() {
    if (this._recording) return Promise.resolve()
    if (this._starting) return this._starting
    if (!HAS_WINDOW) { this.lastReason = 'no_window'; return Promise.resolve() }
    this._starting = this._startInner()
      .catch((err) => this._fail('could not start', err))
      .finally(() => { this._starting = null })
    return this._starting
  }

  /** Stop recording and send what is buffered as the final chunk. */
  stop() {
    if (this._recording) this._finish('stopped')
    return this._uploading
  }

  async _startInner() {
    const sessionId = this._client.identity.sessionId
    if (!sessionId) { this.lastReason = 'no_session'; return }

    const state = this._readState(sessionId)
    if (state && state.sampled === false) { this.lastReason = 'not_sampled'; return }

    const config = await this._fetchConfig()
    this.serverConfig = config
    if (!config) { this.lastReason = 'unreachable'; return }
    if (!config.enabled) { this.lastReason = config.reason || 'disabled'; return }

    const rate = typeof config.sampleRate === 'number' ? config.sampleRate : this._options.sampleRate
    const sampled = state ? state.sampled === true : sampledIn(sessionId, rate)
    this._writeState({ sid: sessionId, sampled, seq: state ? state.seq : 0 })
    if (!sampled) { this.lastReason = 'not_sampled'; return }

    const record = await this._loadRecorder()
    if (typeof record !== 'function') throw new Error('@rrweb/record did not provide record()')

    const o = this._options
    // The stricter side wins for privacy: masked if either the server or the page says so.
    const maskInputs = o.maskInputs !== false || config.maskInputs === true
    const maskAllText = o.maskAllText === true || config.maskAllText === true
    const maskTextSelector = [
      ...ALWAYS_MASK_SELECTORS,
      ...(maskAllText ? ['*'] : []),
      ...(o.maskSelector ? [o.maskSelector] : []),
    ].join(',')
    const blockSelector = [
      ...ALWAYS_BLOCK_SELECTORS,
      ...(o.blockSelector ? [o.blockSelector] : []),
    ].join(',')

    this._sessionId = sessionId
    this._seq = state ? state.seq : 0
    this._startedAt = this._now()
    this._bytesSent = 0
    this._recorderErrors = 0
    this._lastHref = window.location.href
    if (typeof config.maxSessionSeconds === 'number') o.maxSessionSeconds = Math.min(o.maxSessionSeconds, config.maxSessionSeconds)
    if (typeof config.maxSessionBytes === 'number') o.maxSessionBytes = Math.min(o.maxSessionBytes, config.maxSessionBytes)
    if (typeof config.flushIntervalMs === 'number' && config.flushIntervalMs > 0) o.flushIntervalMs = config.flushIntervalMs

    this._recorder = record
    this._recording = true
    this.lastReason = null
    this._stopRecorder = record({
      emit: (event) => this._onEvent(event),
      maskAllInputs: maskInputs,
      // With maskAllInputs off rrweb still masks password fields; the selectors above cover the rest.
      maskInputOptions: maskInputs ? undefined : { password: true },
      maskTextSelector,
      blockSelector,
      // Scripts, comments and head metadata are never serialised: nothing executable, less data.
      slimDOMOptions: 'all',
      inlineStylesheet: true,
      recordCanvas: o.recordCanvas === true,
      collectFonts: false,
      // Mouse and scroll are sampled; every keystroke's final value is kept, never each key.
      sampling: { mousemove: 50, mouseInteraction: true, scroll: 150, input: 'last' },
      // A fresh snapshot every ten minutes keeps seeking cheap in long sessions.
      checkoutEveryNms: 10 * 60 * 1000,
      errorHandler: (err) => this._recorderError(err),
    })
    if (typeof this._stopRecorder !== 'function') {
      this._recording = false
      throw new Error('@rrweb/record did not start')
    }

    this._installListeners()
    this._wrapLog()
  }

  // ---- events ---------------------------------------------------------------------------------

  _onEvent(event) {
    if (!this._recording) return
    try {
      this._noteNavigation()
      const json = JSON.stringify(event)
      this._buffer.push(json)
      this._bufferBytes += json.length

      const o = this._options
      if (this._now() - this._startedAt > o.maxSessionSeconds * 1000) { this._finish('max_duration'); return }
      if (this._bytesSent + this._bufferBytes > o.maxSessionBytes) { this._finish('max_bytes'); return }

      if (this._buffer.length >= o.flushEvents || this._bufferBytes >= o.flushBytes) this._flush(false)
      else this._schedule()
    } catch (err) {
      this._fail('could not buffer an event', err)
    }
  }

  /** SPA route changes leave no rrweb Meta event; a custom event marks them for the viewer. */
  _noteNavigation() {
    const href = window.location.href
    if (href === this._lastHref) return
    this._lastHref = href
    this._custom('ziplogger.navigation', { url: window.location.origin + window.location.pathname })
  }

  _custom(tag, payload) {
    const json = JSON.stringify({ type: EVENT_CUSTOM, timestamp: this._now(), data: { tag, payload } })
    this._buffer.push(json)
    this._bufferBytes += json.length
  }

  _schedule() {
    if (this._timer !== null) return
    this._timer = setTimeout(() => { this._timer = null; this._flush(false) }, this._options.flushIntervalMs)
    if (typeof this._timer === 'object' && this._timer.unref) this._timer.unref()
  }

  /** Close the buffer into a numbered chunk and queue it. `final` marks the recording as ended. */
  _flush(final, urgent = false) {
    if (this._timer !== null) { clearTimeout(this._timer); this._timer = null }
    if (this._buffer.length === 0) return

    const events = this._buffer
    this._buffer = []
    this._bufferBytes = 0

    if (this._pending.length >= this._options.maxPendingChunks) {
      // Uploads are not keeping up. Recording more only grows the backlog; stop, keep what is queued.
      this.dropped += events.length
      if (this._recording) this._finish('upload_backlog')
      return
    }

    const seq = this._seq++
    this._writeState({ sid: this._sessionId, sampled: true, seq: this._seq })
    this._pending.push({ seq, events, final, urgent })
    this._uploading = this._uploading.then(() => this._drain()).catch(() => {})
  }

  async _drain() {
    while (this._pending.length > 0) {
      const chunk = this._pending[0]
      const ok = await this._upload(chunk)
      this._pending.shift()
      if (!ok) this.dropped += chunk.events.length
    }
  }

  _payload(chunk) {
    const identity = this._client.identity
    const meta = {
      // Origin and path only: query strings are where tokens and reset codes live.
      url: window.location.origin + window.location.pathname,
      userId: identity.userId ?? undefined,
      anonymousId: identity.anonymousId ?? undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      sdk: REPLAY_SDK_VERSION,
      final: chunk.final,
    }
    return '{"sessionId":' + JSON.stringify(this._sessionId)
      + ',"sequence":' + chunk.seq
      + ',"events":[' + chunk.events.join(',') + ']'
      + ',"meta":' + JSON.stringify(meta) + '}'
  }

  /**
   * One chunk, retried with the SAME sequence number on 429/408/5xx and network errors — the
   * server dedupes on (session, sequence), so a retry that already landed changes nothing.
   * 409 means another tab is recording under this session id (a duplicated tab copies
   * sessionStorage); this tab stops rather than fight over the sequence.
   */
  async _upload(chunk) {
    const text = this._payload(chunk)
    let body = text
    if (this._compress) {
      try { body = await this._compress(text) } catch { body = text }
    }
    const compressed = typeof body !== 'string'
    const size = compressed ? body.byteLength : body.length
    const headers = { 'Content-Type': 'application/json', 'X-Api-Key': this._client._apiKey }
    if (compressed) headers['Content-Encoding'] = 'gzip'
    // keepalive survives page unload but is capped at 64 KB in flight; a larger last chunk goes
    // out as a plain request and may be lost if the tab closes at that instant.
    const keepalive = (chunk.final || chunk.urgent) && size <= 60_000

    for (let attempt = 0; ; attempt++) {
      let retryAfterMs = null
      try {
        const response = await this._fetch(this._url, { method: 'POST', headers, body, keepalive })
        if (response.ok) { this._bytesSent += size; return true }
        if (response.status === 409) { this._finish('sequence_conflict'); return false }
        if (response.status === 403) { this._finish('disabled'); return false }
        if (response.status === 413) { this._finish('server_limit'); return false }
        if (response.status !== 429 && response.status !== 408 && response.status < 500) return false
        const header = response.headers.get('retry-after')
        if (header && !Number.isNaN(Number(header))) retryAfterMs = Number(header) * 1000
      } catch {
        // offline / network failure — transient
      }
      if (keepalive || attempt >= 2) return false
      await sleep(Math.min(retryAfterMs ?? [1_000, 4_000, 15_000][attempt], 30_000))
    }
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  _finish(reason) {
    this.lastReason = reason
    if (!this._recording && !this._stopRecorder) return
    this._recording = false
    if (this._stopRecorder) {
      try { this._stopRecorder() } catch { /* the recorder is being discarded either way */ }
      this._stopRecorder = null
    }
    this._recorder = null
    for (const detach of this._detach.splice(0)) detach()
    if (this._unwrapLog) { this._unwrapLog(); this._unwrapLog = null }
    // The final chunk is never empty: a marker says why the recording ended.
    this._custom('ziplogger.stop', { reason })
    this._flush(true)
  }

  _fail(what, err) {
    this._finish('error')
    this.dropped += this._buffer.length
    this._buffer = []
    this._bufferBytes = 0
    if (typeof console !== 'undefined' && console.debug)
      console.debug(`ZipLogger session replay ${what}; replay is off for this session.`, err)
  }

  _recorderError(err) {
    // rrweb reports a problem serialising one mutation; the recording goes on. A recorder that
    // keeps failing is not producing a usable replay, so it is stopped.
    if (++this._recorderErrors >= 20) this._fail('recorder kept failing', err)
    return true
  }

  _installListeners() {
    const flushSoon = () => { if (this._recording) this._flush(false, true) }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushSoon() }
    const onNavigate = () => { if (this._recording) this._noteNavigation() }
    window.addEventListener('pagehide', flushSoon)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('popstate', onNavigate)
    window.addEventListener('hashchange', onNavigate)
    this._detach.push(
      () => window.removeEventListener('pagehide', flushSoon),
      () => document.removeEventListener('visibilitychange', onVisibility),
      () => window.removeEventListener('popstate', onNavigate),
      () => window.removeEventListener('hashchange', onNavigate),
    )
  }

  /** While recording, every log line carries the session id so the viewer can place it on the timeline. */
  _wrapLog() {
    const client = this._client
    const original = client.log
    const sessionId = this._sessionId
    client.log = (entry) => original.call(client, {
      ...entry,
      fields: { sessionId, ...(entry && entry.fields) },
    })
    this._unwrapLog = () => { if (client.log !== original) client.log = original }
  }

  // ---- server ---------------------------------------------------------------------------------

  async _fetchConfig() {
    try {
      const response = await this._fetch(this._url + '/config', {
        method: 'GET',
        headers: { 'X-Api-Key': this._client._apiKey },
      })
      if (!response.ok) return null
      const config = await response.json()
      return config && typeof config === 'object' ? config : null
    } catch {
      return null
    }
  }

  // ---- storage --------------------------------------------------------------------------------

  _readState(sessionId) {
    try {
      const raw = globalThis.sessionStorage ? globalThis.sessionStorage.getItem(STATE_KEY) : null
      if (!raw) return null
      const state = JSON.parse(raw)
      return state && state.sid === sessionId && typeof state.seq === 'number' ? state : null
    } catch { return null }
  }

  _writeState(state) {
    try {
      if (globalThis.sessionStorage) globalThis.sessionStorage.setItem(STATE_KEY, JSON.stringify(state))
    } catch { /* storage disabled; the sequence lives in memory for this page */ }
  }
}
