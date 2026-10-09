'use strict'

/**
 * Release health: one session per process, sent to POST /ingest/v1/sessions in the shape Sentry SDKs use
 * (sid, did, started, timestamp, status, errors, attrs.release). The server keeps the latest update per sid.
 *
 *   - started: when the client is created;
 *   - first error-level log: errors = 1 (later errors are not re-sent);
 *   - normal end: status "exited" on client.close() or when the event loop drains (beforeExit);
 *   - crash: status "crashed" from `uncaughtExceptionMonitor`, which observes without changing how the process
 *     dies. The process is about to exit, so that one update is sent synchronously by a short-lived child process
 *     (at most 3 seconds); the API key travels on its stdin, never on its command line.
 *
 * A process ended with process.exit() keeps its last status (ok or errored), which counts as not crashed.
 * Best effort throughout: nothing here throws or retries.
 */

const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')

// Runs in the child: read {url, apiKey, body} from stdin and POST it once.
const SEND_ONCE = "let s='';process.stdin.on('data',d=>{s+=d}).on('end',async()=>{try{const m=JSON.parse(s);"
  + "await fetch(m.url,{method:'POST',headers:{'Content-Type':'application/json','X-Api-Key':m.apiKey},body:m.body,"
  + "signal:AbortSignal.timeout(2500)})}catch{}})"

class ReleaseSession {
  /** @param {{ url: string, apiKey: string, release: string, environment: string, distinctId?: string, timeoutMs: number }} o */
  constructor(o) {
    this._o = o
    this.sid = randomUUID()
    this.started = new Date().toISOString()
    this.status = 'ok'
    this.errors = 0
    this._onBeforeExit = () => { void this.end() }
    this._onCrash = () => this.crash()
    process.on('beforeExit', this._onBeforeExit)
    process.on('uncaughtExceptionMonitor', this._onCrash)
    this._pending = this._send()
  }

  error() {
    if (this.status !== 'ok') return
    this.errors++
    if (this.errors === 1) this._pending = this._pending.then(() => this._send())
  }

  /** Ends the session normally; resolves when the update was sent (or failed). */
  end() {
    if (this.status !== 'ok') return this._pending
    this.status = 'exited'
    this._detach()
    this._pending = this._pending.then(() => this._send())
    return this._pending
  }

  crash() {
    if (this.status !== 'ok') return
    this.status = 'crashed'
    this.errors = Math.max(1, this.errors)
    this._detach()
    try {
      spawnSync(process.execPath, ['-e', SEND_ONCE], {
        input: JSON.stringify({ url: this._o.url, apiKey: this._o.apiKey, body: this._body() }),
        timeout: 3000, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
      })
    } catch { /* best effort */ }
  }

  _detach() {
    process.removeListener('beforeExit', this._onBeforeExit)
    process.removeListener('uncaughtExceptionMonitor', this._onCrash)
  }

  _body() {
    return JSON.stringify([{
      sid: this.sid, did: this._o.distinctId, started: this.started, timestamp: new Date().toISOString(),
      status: this.status, errors: this.errors, attrs: { release: this._o.release, environment: this._o.environment },
    }])
  }

  async _send() {
    try {
      await fetch(this._o.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': this._o.apiKey },
        body: this._body(), signal: AbortSignal.timeout(this._o.timeoutMs),
      })
    } catch { /* best effort */ }
  }
}

module.exports = { ReleaseSession }
