import { test } from 'node:test'
import assert from 'node:assert/strict'

// The SDK decides "am I in a browser" when it loads, so the browser globals go in before the import.
const windowHandlers = {}, documentHandlers = {}
globalThis.window = {
  location: { hostname: 'shop.test', href: 'https://shop.test/cart' },
  addEventListener: (name, fn) => { windowHandlers[name] = fn },
  removeEventListener: () => {},
}
globalThis.document = { visibilityState: 'visible', addEventListener: (name, fn) => { documentHandlers[name] = fn } }
const requests = []
globalThis.fetch = async (url, init) => { requests.push({ url, ...init }); return { ok: true, status: 202, headers: new Map() } }
const { ZipLoggerBrowser } = await import('../index.js')

const sessions = () => requests.filter(r => r.url.endsWith('/ingest/v1/sessions')).map(r => ({ ...JSON.parse(r.body)[0], keepalive: r.keepalive }))
const client = (options = {}) => new ZipLoggerBrowser({ endpoint: 'https://ziplogger.test', apiKey: 'zk_browser', release: 'shop@2.0.0',
  flushIntervalMs: 60000, ...options })

test('a page session starts, reports its first error and ends when the page is left', () => {
  requests.length = 0
  const c = client({ userId: 'u42' })
  c.log({ severity: 'error', message: 'checkout failed' })
  c.log({ severity: 'error', message: 'again' })
  c.log({ severity: 'info', message: 'fine' })
  windowHandlers.pagehide()
  windowHandlers.pagehide()   // a second hide does not report again
  const s = sessions()
  assert.deepEqual(s.map(x => [x.status, x.errors, x.keepalive]), [['ok', 0, false], ['ok', 1, false], ['exited', 2, true]])
  assert.equal(new Set(s.map(x => x.sid)).size, 1)
  assert.deepEqual([s[0].did, s[0].attrs.release, s[0].attrs.environment], ['u42', 'shop@2.0.0', 'production'])
  assert.equal(requests.find(r => r.url.endsWith('/sessions')).headers['X-Api-Key'], 'zk_browser')
  assert.equal(c.sessionStatus, 'exited')
})

test('an uncaught error crashes the session once; leaving the page afterwards does not overwrite it', () => {
  requests.length = 0
  const c = client()
  c.captureGlobalErrors()
  windowHandlers.error({ message: 'boom', error: new Error('boom'), filename: 'app.js', lineno: 1, colno: 2 })
  windowHandlers.unhandledrejection({ reason: new Error('later') })
  windowHandlers.pagehide()
  assert.deepEqual(sessions().map(x => [x.status, x.keepalive]), [['ok', false], ['crashed', true]])
  assert.equal(sessions()[1].errors, 1)
  assert.equal(c.sessionStatus, 'crashed')
})

test('no release, or trackSessions: false, means no sessions', () => {
  requests.length = 0
  assert.equal(client({ release: undefined }).sessionStatus, null)
  assert.equal(client({ trackSessions: false }).sessionStatus, null)
  assert.equal(sessions().length, 0)
})
