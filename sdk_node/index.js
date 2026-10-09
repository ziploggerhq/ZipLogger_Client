'use strict'

/**
 * ZipLogger Node.js SDK — core client.
 *
 * Mirrors the official .NET client's delivery semantics:
 *   - log() never blocks and never throws — delivery is asynchronous;
 *   - bounded queue with drop-on-backpressure (counted, never unbounded memory);
 *   - NDJSON batches over HTTP with retry + exponential backoff, honoring 429 Retry-After;
 *   - automatic enrichment: source, release, commit SHA, environment, hostname.
 *
 * Zero dependencies (uses global fetch, Node >= 18).
 */

const os = require('node:os')
const path = require('node:path')
const { ReleaseSession } = require('./session.js')

const SEVERITIES = new Set(['debug', 'info', 'warn', 'error', 'fatal'])

class ZipLoggerClient {
  /** @param {import('./index').ZipLoggerOptions} options */
  constructor(options) {
    if (!options || !options.endpoint) throw new Error('ZipLogger: endpoint is required')
    if (!options.apiKey) throw new Error('ZipLogger: apiKey is required')

    const trimmed = String(options.endpoint).replace(/\/+$/, '')
    this._url = /\/logs$/i.test(trimmed) ? trimmed : trimmed + '/ingest/v1/logs'
    this._apiKey = options.apiKey

    this._source = options.source || process.env.ZIPLOGGER_SOURCE || defaultSource()
    this._release = options.release || process.env.ZIPLOGGER_RELEASE || packageVersion()
    this._commitSha = options.commitSha || process.env.ZIPLOGGER_COMMIT_SHA
      || process.env.GIT_COMMIT || process.env.COMMIT_SHA || undefined
    this._environment = options.environment || process.env.ZIPLOGGER_ENVIRONMENT
      || process.env.NODE_ENV || 'production'
    this._hostname = os.hostname()
    this._tags = Array.isArray(options.tags) && options.tags.length ? options.tags : undefined

    this._queueCapacity = options.queueCapacity ?? 10_000
    this._batchSize = options.batchSize ?? 100
    this._flushInterval = options.flushIntervalMs ?? 2_000
    this._maxRetries = options.maxRetries ?? 5
    this._retryBaseDelay = options.retryBaseDelayMs ?? 500
    this._retryMaxDelay = options.retryMaxDelayMs ?? 30_000
    this._timeout = options.timeoutMs ?? 10_000

    this.dropped = 0
    this._queue = []
    this._timer = null
    this._sending = Promise.resolve()
    this._closed = false

    // Release health: one session per process when a release is known (see session.js). trackSessions: false turns it off.
    this._session = options.trackSessions !== false && this._release
      ? new ReleaseSession({
        url: trimmed.replace(/\/ingest\/v1\/logs$/i, '') + '/ingest/v1/sessions', apiKey: this._apiKey,
        release: String(this._release), environment: this._environment, distinctId: options.sessionDistinctId, timeoutMs: this._timeout,
      })
      : null
  }

  /** This process's release-health session status (ok, exited, crashed), or null when not tracked. */
  get sessionStatus() { return this._session ? this._session.status : null }

  /**
   * Queue one entry for background delivery. Never blocks, never throws.
   * @param {import('./index').LogEntry} entry
   */
  log(entry) {
    if (this._closed) { this.dropped++; return }
    if (this._queue.length >= this._queueCapacity) { this.dropped++; return }

    const fields = { environment: this._environment, machineName: this._hostname, ...entry.fields }
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
    if (record.severity === 'error' || record.severity === 'fatal') this._session?.error()
    if (this._queue.length >= this._batchSize) this._kick(0)
    else this._kick(this._flushInterval)
  }

  _kick(delay) {
    if (this._timer) {
      if (delay > 0) return // linger timer already pending
      clearTimeout(this._timer)
    }
    this._timer = setTimeout(() => {
      this._timer = null
      // Chain sends so batches stay ordered and only one request is in flight.
      this._sending = this._sending.then(() => this._drain()).catch(() => {})
    }, delay)
    if (this._timer.unref) this._timer.unref() // never keep the process alive
  }

  async _drain() {
    while (this._queue.length > 0) {
      const batch = this._queue.splice(0, this._batchSize)
      await this._send(batch)
    }
  }

  async _send(batch) {
    const payload = batch.map((e) => JSON.stringify(e)).join('\n')

    for (let attempt = 0; ; attempt++) {
      let retryAfterMs = null
      try {
        const response = await fetch(this._url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-ndjson', 'X-Api-Key': this._apiKey },
          body: payload,
          signal: AbortSignal.timeout(this._timeout),
        })
        if (response.ok) return
        if (response.status !== 429 && response.status !== 408 && response.status < 500) {
          this.dropped += batch.length // 400/401/... — retrying cannot help
          return
        }
        const header = response.headers.get('retry-after')
        if (header && !Number.isNaN(Number(header))) retryAfterMs = Number(header) * 1000
      } catch {
        // network failure / timeout — transient
      }

      if (attempt >= this._maxRetries) {
        this.dropped += batch.length
        return
      }
      const backoff = Math.min(this._retryBaseDelay * 2 ** attempt, this._retryMaxDelay)
      const delay = Math.min(retryAfterMs ?? backoff * (1 + Math.random() * 0.2), this._retryMaxDelay)
      await sleep(this._closed ? Math.min(delay, 250) : delay)
    }
  }

  /** Send anything still buffered; resolves when the queue is empty. */
  async flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    this._sending = this._sending.then(() => this._drain()).catch(() => {})
    await this._sending
  }

  /** Flush (bounded) and stop accepting entries. */
  async close(timeoutMs = 5_000) {
    this._closed = true
    await Promise.race([Promise.all([this.flush(), this._session?.end()]), sleep(timeoutMs)])
  }
}

function sleep(ms) { return new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref() }) }

function defaultSource() {
  try { return path.basename(process.argv[1] || '', path.extname(process.argv[1] || '')) || 'node' }
  catch { return 'node' }
}

function packageVersion() {
  try {
    const pkg = require(path.join(process.cwd(), 'package.json'))
    return pkg.version ? String(pkg.version) : undefined
  } catch { return undefined }
}

/** Map common level names/numbers (pino, winston, console) to ZipLogger severities. */
function mapLevel(level) {
  if (typeof level === 'number') {
    // pino numeric levels
    if (level >= 60) return 'fatal'
    if (level >= 50) return 'error'
    if (level >= 40) return 'warn'
    if (level >= 30) return 'info'
    return 'debug'
  }
  const name = String(level || '').toLowerCase()
  if (name === 'warning') return 'warn'
  if (name === 'trace' || name === 'verbose' || name === 'silly') return 'debug'
  if (name === 'critical') return 'fatal'
  return SEVERITIES.has(name) ? name : 'info'
}

module.exports = { ZipLoggerClient, mapLevel }
