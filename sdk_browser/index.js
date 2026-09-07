/**
 * ZipLogger browser SDK — logs, errors, traces and product-analytics events.
 *
 * Same delivery semantics as every ZipLogger SDK — bounded queue, NDJSON batches,
 * retry with backoff honoring 429 Retry-After, drop-on-backpressure, never throws —
 * tuned for the browser: smaller defaults, `fetch(..., { keepalive: true })` so a
 * final flush survives page unload, and automatic page context on every event.
 *
 * Zero dependencies. Works in any environment with `fetch` (tests run under Node).
 */

const SEVERITIES = new Set(['debug', 'info', 'warn', 'error', 'fatal'])
const HAS_WINDOW = typeof window !== 'undefined'

/** Cryptographically-random lowercase hex, for W3C trace/span ids. */
function randomHex(bytes) {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}

export class ZipLoggerBrowser {
  /** @param {import('./index').BrowserOptions} options */
  constructor(options) {
    if (!options || !options.endpoint) throw new Error('ZipLogger: endpoint is required')
    if (!options.apiKey) throw new Error('ZipLogger: apiKey is required')

    const trimmed = String(options.endpoint).replace(/\/+$/, '')
    this._url = /\/logs$/i.test(trimmed) ? trimmed : trimmed + '/ingest/v1/logs'
    // Events are a different endpoint with a different payload, so they get their own URL and
    // queue rather than being squeezed through the log pipeline.
    this._eventsUrl = trimmed.replace(/\/ingest\/v1\/logs$/i, '') + '/ingest/v1/events'
    this._apiKey = options.apiKey
    this._source = options.source || (HAS_WINDOW ? window.location.hostname : 'browser')
    this._release = options.release
    this._commitSha = options.commitSha
    this._environment = options.environment || 'production'
    this._tags = Array.isArray(options.tags) && options.tags.length ? options.tags : undefined
    this._includePageContext = options.includePageContext !== false

    this._queueCapacity = options.queueCapacity ?? 1_000
    this._batchSize = options.batchSize ?? 20
    this._flushInterval = options.flushIntervalMs ?? 3_000
    this._maxRetries = options.maxRetries ?? 2
    this._retryBaseDelay = options.retryBaseDelayMs ?? 500
    // How long after an instrumented fetch a tracked event still counts as "happened inside
    // that request". Long enough for "call the API, then track the result"; short enough that an
    // event a minute later is not pinned to a stale trace. 0 disables inference.
    this._requestCorrelationTtl = options.requestCorrelationTtlMs ?? 5_000
    // The most recent instrumented fetch: { traceId, at }. Single source of truth for event ↔
    // request correlation; written by instrumentFetch, read by track.
    this._lastRequest = null

    this.dropped = 0
    this._queue = []
    this._timer = null
    this._sending = Promise.resolve()
    this._detach = []

    this._events = []
    this._eventTimer = null
    this._eventSending = Promise.resolve()

    // An event with neither a user id nor an anonymous id is rejected by the server, so a
    // visitor who has not signed in needs a stable id of their own. It lives in localStorage so
    // it survives reloads -- that is what lets identify() later attach their pre-login events to
    // the account. Session id is per-tab and per-visit, so it belongs in sessionStorage.
    this._userId = options.userId ?? null
    this._anonymousId = options.anonymousId ?? this._persistedId('local', 'zl_anon', 'anon')
    this._sessionId = options.sessionId ?? this._persistedId('session', 'zl_sess', 'sess')

    if (HAS_WINDOW) {
      const onHide = () => { void this.flush(true) }
      window.addEventListener('pagehide', onHide)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') onHide()
      })
      this._detach.push(() => window.removeEventListener('pagehide', onHide))
    }
  }

  /**
   * Queue one event for background delivery. Never blocks, never throws.
   * @param {import('./index').BrowserLogEntry} entry
   */
  log(entry) {
    if (this._queue.length >= this._queueCapacity) { this.dropped++; return }

    const fields = { environment: this._environment, ...entry.fields }
    if (this._includePageContext && HAS_WINDOW) {
      fields.url = window.location.href
      fields.userAgent = navigator.userAgent
    }
    const record = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      severity: SEVERITIES.has(entry.severity) ? entry.severity : 'info',
      message: entry.message ?? '',
      source: entry.source ?? this._source,
      release: entry.release ?? this._release,
      commitSha: entry.commitSha ?? this._commitSha,
      stackTrace: entry.stackTrace,
      fields,
      tags: entry.tags ?? this._tags,
    }
    if (entry.error instanceof Error) {
      record.stackTrace = record.stackTrace ?? (entry.error.stack || String(entry.error))
      fields.exceptionType = entry.error.name
      fields.exceptionMessage = entry.error.message
    }
    delete record.error

    this._queue.push(record)
    this._schedule(this._queue.length >= this._batchSize ? 0 : this._flushInterval)
  }

  /** Convenience: report a caught error with optional context. */
  captureError(error, fields) {
    this.log({
      severity: 'error',
      message: error && error.message ? error.message : String(error),
      error: error instanceof Error ? error : undefined,
      fields,
    })
  }

  /**
   * Record a product-analytics event: a signup, a checkout, a plan change.
   *
   * Separate from `log()` on purpose. Logs are lines you read when something breaks; events are
   * things people did, and they answer different questions in different places in ZipLogger.
   * Never blocks, never throws.
   *
   * The event is linked to the request it happened in through `requestId`, which ZipLogger
   * correlates with logs and traces carrying the same trace id. With `instrumentFetch()` active,
   * the trace id of the most recent instrumented request (within `requestCorrelationTtlMs`,
   * default 5 s) is attached automatically; `options.requestId` overrides that. Events with no
   * recent request carry no `requestId` — one is never invented.
   *
   * @param {string} name Event name, e.g. "checkout_started". Lower-cased server-side.
   * @param {Record<string, unknown>} [properties] Your own properties. Values that look like
   *   credentials are redacted server-side; do not send passwords, tokens or card numbers.
   * @param {import('./index').TrackOptions} [options]
   */
  track(name, properties, options) {
    if (!name || typeof name !== 'string') return
    if (this._events.length >= this._queueCapacity) { this.dropped++; return }

    const explicit = options && typeof options === 'object' ? options.requestId : undefined
    const requestId = typeof explicit === 'string' && explicit.length > 0 ? explicit : this._recentRequestId()

    const event = {
      type: 'track',
      name,
      timestamp: new Date().toISOString(),
      userId: this._userId ?? undefined,
      anonymousId: this._anonymousId ?? undefined,
      sessionId: this._sessionId ?? undefined,
      requestId,
      environment: this._environment,
      release: this._release,
      commitSha: this._commitSha,
      // An idempotency key, so a retry after a timeout cannot count the same event twice.
      insertId: randomHex(12),
      properties: properties && typeof properties === 'object' ? properties : undefined,
    }
    if (this._includePageContext && HAS_WINDOW) {
      event.url = window.location.href
      event.page = window.location.pathname
    }

    this._events.push(event)
    this._scheduleEvents(this._events.length >= this._batchSize ? 0 : this._flushInterval)
  }

  /**
   * Attach everything this browser has done anonymously to a real account, and use the account
   * id from now on.
   *
   * Call it once after sign-in. The server links the two ids, so the events this visitor sent
   * before signing in stop being a separate person -- which is the whole point of holding an
   * anonymous id in the first place.
   *
   * @param {string} userId Your own id for the user.
   * @param {Record<string, unknown>} [properties] Optional properties for the identify event.
   */
  identify(userId, properties) {
    if (!userId || typeof userId !== 'string') return
    const anonymousId = this._anonymousId

    this._userId = userId
    if (!anonymousId) return          // nothing to link; later events simply carry the user id

    if (this._events.length >= this._queueCapacity) { this.dropped++; return }
    this._events.push({
      type: 'identify',
      timestamp: new Date().toISOString(),
      userId,
      anonymousId,
      sessionId: this._sessionId ?? undefined,
      environment: this._environment,
      insertId: randomHex(12),
      properties: properties && typeof properties === 'object' ? properties : undefined,
    })
    // Linking is what every later event depends on, so it does not wait for a full batch.
    this._scheduleEvents(0)
  }

  /** Forget the signed-in user, e.g. on sign-out. Later events are anonymous again. */
  reset() {
    this._userId = null
    this._anonymousId = this._newId('anon')
    this._sessionId = this._newId('sess')
    this._store('local', 'zl_anon', this._anonymousId)
    this._store('session', 'zl_sess', this._sessionId)
  }

  /** The ids this client is currently attributing events to. Useful in tests and debugging. */
  get identity() {
    return { userId: this._userId, anonymousId: this._anonymousId, sessionId: this._sessionId }
  }

  /** The trace id of the latest instrumented fetch, if it is still inside the correlation window. */
  _recentRequestId() {
    const last = this._lastRequest
    if (!last || this._requestCorrelationTtl <= 0) return undefined
    return Date.now() - last.at <= this._requestCorrelationTtl ? last.traceId : undefined
  }

  /**
   * Start capturing window `error` and `unhandledrejection` events.
   * Returns a function that stops capturing.
   */
  captureGlobalErrors() {
    if (!HAS_WINDOW) return () => {}
    const onError = (event) => {
      this.log({
        severity: 'error',
        message: event.message || 'Uncaught error',
        error: event.error instanceof Error ? event.error : undefined,
        fields: { file: event.filename, line: event.lineno, column: event.colno, handler: 'window.onerror' },
      })
    }
    const onRejection = (event) => {
      const reason = event.reason
      this.log({
        severity: 'error',
        message: reason && reason.message ? `Unhandled rejection: ${reason.message}` : 'Unhandled promise rejection',
        error: reason instanceof Error ? reason : undefined,
        fields: { handler: 'unhandledrejection' },
      })
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    const stop = () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
    this._detach.push(stop)
    return stop
  }

  /**
   * Instrument `window.fetch` for distributed tracing: every outgoing request to your own
   * backend gets a W3C `traceparent` header, so the server continues the SAME trace — a failed
   * browser call and its backend waterfall share one trace id in ZipLogger. Failed requests
   * (HTTP >= 400 or network errors) are logged automatically with that trace id, which becomes
   * a "View trace" link on the server.
   *
   * Propagation targets: same-origin requests by default; pass `propagateTo` (array of origin
   * prefixes, e.g. ["https://api.mycompany.com"]) for cross-origin APIs you control — those
   * servers must allow the `traceparent` header in CORS. Returns a function that stops
   * instrumenting.
   *
   * Each instrumented request's trace id is also remembered as the most recent request, so a
   * `track()` call shortly after it carries that id as `requestId` (see `track`).
   *
   * @param {{ propagateTo?: string[], logFailures?: boolean }} [options]
   */
  instrumentFetch(options = {}) {
    if (!HAS_WINDOW || typeof window.fetch !== 'function') return () => {}
    const propagateTo = options.propagateTo || []
    const logFailures = options.logFailures !== false
    const sendSpans = options.sendSpans !== false
    const serviceName = options.serviceName || `${this._source}-browser`
    const ingestOrigin = this._url.split('/').slice(0, 3).join('/')
    const original = window.fetch.bind(window)
    const self = this
    const spanQueue = []
    let spanTimer = null

    const shouldPropagate = (url) => {
      if (url.startsWith(ingestOrigin)) return false // never trace our own telemetry shipping
      if (url.startsWith(window.location.origin) || url.startsWith('/')) return true
      return propagateTo.some((origin) => url.startsWith(origin))
    }

    // Ship the browser-side root spans over OTLP/JSON, so the ZipLogger waterfall shows the
    // request from the user's browser down through every backend service — one trace.
    const flushSpans = () => {
      spanTimer = null
      if (spanQueue.length === 0) return
      const spans = spanQueue.splice(0, spanQueue.length)
      const payload = {
        resourceSpans: [{
          resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
          scopeSpans: [{ spans }],
        }],
      }
      void original(`${ingestOrigin}/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': self._apiKey },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {})
    }
    const enqueueSpan = (span) => {
      if (!sendSpans) return
      spanQueue.push(span)
      if (spanTimer === null) spanTimer = setTimeout(flushSpans, self._flushInterval)
    }

    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!shouldPropagate(String(url))) return original(input, init)

      const traceId = randomHex(16)
      const spanId = randomHex(8)
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      headers.set('traceparent', `00-${traceId}-${spanId}-01`)
      // The trace id is established here, before the request leaves; record it so events tracked
      // in the next few seconds link to this request. Concurrent fetches: the latest started wins.
      self._lastRequest = { traceId, at: Date.now() }

      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const path = String(url).replace(/^https?:\/\/[^/]+/, '') || '/'
      const startNs = String(BigInt(Date.now()) * 1000000n)
      const finish = (status, errorMessage) => {
        enqueueSpan({
          traceId, spanId,
          name: `${method} ${path.split('?')[0]}`,
          kind: 'SPAN_KIND_CLIENT',
          startTimeUnixNano: startNs,
          endTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
          attributes: [
            { key: 'url.full', value: { stringValue: String(url) } },
            { key: 'http.request.method', value: { stringValue: method } },
            ...(status ? [{ key: 'http.response.status_code', value: { intValue: String(status) } }] : []),
          ],
          ...(errorMessage || (status && status >= 400)
            ? { status: { code: 'STATUS_CODE_ERROR', message: errorMessage || `HTTP ${status}` } }
            : {}),
        })
      }

      try {
        const response = await original(input, { ...init, headers })
        finish(response.status)
        if (logFailures && response.status >= 400) {
          self.log({
            severity: response.status >= 500 ? 'error' : 'warn',
            message: `${method} ${url} failed with HTTP ${response.status}`,
            fields: { traceId, spanId, httpStatus: response.status, requestUrl: String(url) },
          })
        }
        return response
      } catch (error) {
        const message = error && error.message ? error.message : 'network error'
        finish(null, message)
        if (logFailures) {
          self.log({
            severity: 'error',
            message: `${method} ${url} failed: ${message}`,
            error: error instanceof Error ? error : undefined,
            fields: { traceId, spanId, requestUrl: String(url) },
          })
        }
        throw error
      }
    }

    const stop = () => {
      window.fetch = original
      if (spanTimer !== null) { clearTimeout(spanTimer); flushSpans() }
    }
    this._detach.push(stop)
    return stop
  }

  /** A stable id from web storage, minted on first use. Falls back to memory when storage is
   *  unavailable (private mode, blocked cookies) -- attribution is then per-page, never an error. */
  _persistedId(kind, key, prefix) {
    const existing = this._read(kind, key)
    if (existing) return existing
    const id = this._newId(prefix)
    this._store(kind, key, id)
    return id
  }

  _newId(prefix) { return `${prefix}_${randomHex(10)}` }

  _read(kind, key) {
    try {
      const store = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage
      return store ? store.getItem(key) : null
    } catch { return null }          // storage disabled: not an error worth surfacing
  }

  _store(kind, key, value) {
    try {
      const store = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage
      if (store) store.setItem(key, value)
    } catch { /* storage disabled; the id stays in memory for this page */ }
  }

  _scheduleEvents(delay) {
    if (this._eventTimer !== null) {
      if (delay > 0) return
      clearTimeout(this._eventTimer)
    }
    this._eventTimer = setTimeout(() => {
      this._eventTimer = null
      this._eventSending = this._eventSending.then(() => this._drainEvents(false)).catch(() => {})
    }, delay)
    if (typeof this._eventTimer === 'object' && this._eventTimer.unref) this._eventTimer.unref()
  }

  async _drainEvents(keepalive) {
    while (this._events.length > 0) {
      const batch = this._events.splice(0, this._batchSize)
      await this._post(this._eventsUrl, batch, batch.length, keepalive)
    }
  }

  _schedule(delay) {
    if (this._timer !== null) {
      if (delay > 0) return
      clearTimeout(this._timer)
    }
    this._timer = setTimeout(() => {
      this._timer = null
      this._sending = this._sending.then(() => this._drain(false)).catch(() => {})
    }, delay)
    if (typeof this._timer === 'object' && this._timer.unref) this._timer.unref()
  }

  async _drain(keepalive) {
    while (this._queue.length > 0) {
      const batch = this._queue.splice(0, this._batchSize)
      await this._send(batch, keepalive)
    }
  }

  async _send(batch, keepalive) {
    await this._post(this._url, batch, batch.length, keepalive)
  }

  /**
   * One NDJSON POST with the retry policy both queues share: retry only what retrying can fix
   * (429, 408, 5xx), honour Retry-After, and never retry during page unload -- an unloading page
   * has no time, and a duplicate is worse than a loss when the event already carries an insertId.
   */
  async _post(url, batch, count, keepalive) {
    const payload = batch.map((e) => JSON.stringify(e)).join('\n')

    for (let attempt = 0; ; attempt++) {
      let retryAfterMs = null
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-ndjson', 'X-Api-Key': this._apiKey },
          body: payload,
          keepalive, // survives page unload (64 KB budget — batches are small)
        })
        if (response.ok) return
        if (response.status !== 429 && response.status !== 408 && response.status < 500) {
          this.dropped += count
          return
        }
        const header = response.headers.get('retry-after')
        if (header && !Number.isNaN(Number(header))) retryAfterMs = Number(header) * 1000
      } catch {
        // offline / network failure — transient
      }

      if (keepalive || attempt >= this._maxRetries) {
        this.dropped += count // unloading pages don't get retries
        return
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(retryAfterMs ?? this._retryBaseDelay * 2 ** attempt, 10_000))
        if (typeof timer === 'object' && timer.unref) timer.unref()
      })
    }
  }

  /** Send anything still buffered, logs and events both. Pass keepalive=true during page unload. */
  async flush(keepalive = false) {
    if (this._timer !== null) { clearTimeout(this._timer); this._timer = null }
    if (this._eventTimer !== null) { clearTimeout(this._eventTimer); this._eventTimer = null }
    this._sending = this._sending.then(() => this._drain(keepalive)).catch(() => {})
    this._eventSending = this._eventSending.then(() => this._drainEvents(keepalive)).catch(() => {})
    await Promise.all([this._sending, this._eventSending])
  }

  /** Flush and detach all global listeners. */
  async close() {
    for (const stop of this._detach.splice(0)) stop()
    await this.flush()
  }
}

export default ZipLoggerBrowser
