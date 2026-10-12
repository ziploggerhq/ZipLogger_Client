import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ZipLoggerBrowser } from '../index.js'
import { attachRumCore, describeUrl, templatePath } from '../rum-core.js'

/** A document with a navigation entry, resource entries and observable entry streams (resource, longtask). */
function fixture(options = {}, { navigation, resources = [] } = {}) {
  const client = new ZipLoggerBrowser({ endpoint: 'https://ingest.example.com', apiKey: 'fixture',
    sessionId: 'rum-depth-session', flushIntervalMs: 60000 })
  const listeners = new Map(), docListeners = new Map(), observers = new Map()
  const document = { visibilityState: 'visible', documentElement: {},
    addEventListener: (n, fn) => docListeners.set(n, fn), removeEventListener: n => docListeners.delete(n) }
  class FakeObserver {
    static supportedEntryTypes = ['resource', 'longtask', 'navigation']
    constructor(cb) { this.cb = cb }
    observe({ type }) { observers.set(type, this) }
    disconnect() {}
  }
  const scope = {
    document, location: { href: 'https://shop.example.com/checkout' },
    performance: { getEntriesByType: t => (t === 'navigation' ? (navigation ? [navigation] : []) : t === 'resource' ? resources : []) },
    PerformanceObserver: FakeObserver,
    addEventListener: (n, fn) => listeners.set(n, fn), removeEventListener: n => listeners.delete(n),
    setTimeout: fn => { fn(); return 1 }, clearTimeout() {},
  }
  const vitals = Object.fromEntries(['onCLS', 'onINP', 'onLCP', 'onFCP', 'onTTFB'].map(n => [n, fn => (vitals[`${n}Callback`] = fn)]))
  const rum = attachRumCore(client, { enabled: true, hasConsent: true, getRoute: () => '/checkout', ...options }, vitals, scope)
  const emit = (type, entries) => observers.get(type)?.cb({ getEntries: () => entries })
  const events = name => client._events.filter(e => e.name === name)
  const clean = () => { rum.stop(); clearTimeout(client._eventTimer); client._events = [] }
  return { client, rum, scope, vitals, listeners, docListeners, emit, events, clean }
}

const nav = {
  duration: 1800, type: 'navigate', startTime: 0, redirectStart: 0, redirectEnd: 0,
  domainLookupStart: 10, domainLookupEnd: 30, connectStart: 30, secureConnectionStart: 45, connectEnd: 80,
  requestStart: 85, responseStart: 285, responseEnd: 400, domInteractive: 900, domContentLoadedEventEnd: 1000,
  loadEventEnd: 1790, transferSize: 24000,
}

test('ids in paths are templated and urls lose their query, fragment and credentials', () => {
  assert.equal(templatePath('/orders/12345/items/9f8e7d6c-5b4a-4f3e-8d2c-1b0a9f8e7d6c'), '/orders/:id/items/:id')
  assert.equal(templatePath('/files/abcdef0123456789abcdef?token=secret#x'), '/files/:id')
  assert.equal(templatePath('/api/v1/cart'), '/api/v1/cart')
  assert.deepEqual(describeUrl('https://user:pw@api.example.com/users/42?email=a@b.c', 'https://x'), { host: 'api.example.com', path: '/users/:id' })
  assert.deepEqual(describeUrl('/api/cart?id=1', 'https://shop.example.com/'), { host: 'shop.example.com', path: '/api/cart' })
})

test('FCP and TTFB are vitals like the others, and the page load is broken into phases', () => {
  const f = fixture({}, { navigation: nav })
  f.vitals.onFCPCallback({ name: 'FCP', id: 'v1-fcp', value: 610, rating: 'good' })
  f.vitals.onTTFBCallback({ name: 'TTFB', id: 'v1-ttfb', value: 285, rating: 'good' })
  assert.deepEqual(f.events('web_vital').map(e => [e.properties.metric, e.properties.unit]), [['FCP', 'ms'], ['TTFB', 'ms']])
  const n = f.events('rum_navigation')[0].properties
  assert.equal(n.dnsMs, 20); assert.equal(n.connectMs, 50); assert.equal(n.tlsMs, 35)
  assert.equal(n.requestMs, 200); assert.equal(n.responseMs, 115); assert.equal(n.ttfbMs, 285)
  assert.equal(n.domInteractiveMs, 900); assert.equal(n.loadMs, 1790); assert.equal(n.redirectMs, undefined)
  f.clean()
})

test('the slowest assets of the page load are reported, requests and our own traffic are not', () => {
  const resources = [
    { name: 'https://cdn.example.com/app-abc123.js?v=1', initiatorType: 'script', duration: 900, transferSize: 300000, decodedBodySize: 900000, renderBlockingStatus: 'blocking' },
    { name: 'https://cdn.example.com/hero.jpg', initiatorType: 'img', duration: 1200, transferSize: 0, decodedBodySize: 50000 },
    { name: 'https://shop.example.com/api/cart', initiatorType: 'fetch', duration: 5000, transferSize: 100 },
    { name: 'https://ingest.example.com/ingest/v1/events', initiatorType: 'other', duration: 9000, transferSize: 10 },
    { name: 'https://cdn.example.com/a.css', initiatorType: 'link', duration: 10, transferSize: 1000 },
  ]
  const f = fixture({ maxResources: 2 }, { navigation: nav, resources })
  const r = f.events('rum_resource').map(e => e.properties)
  assert.deepEqual(r.map(x => x.path), ['/hero.jpg', '/app-abc123.js'])
  assert.equal(r[1].resource, 'cdn.example.com/app-abc123.js')
  assert.equal(r[0].cached, true); assert.equal(r[1].renderBlocking, 'blocking'); assert.equal(r[1].host, 'cdn.example.com')
  f.clean()
})

test('fetch and XHR timings carry status, the trace a traced fetch started, and stay within their budget', () => {
  const f = fixture({ maxRequests: 2 })
  f.client._rumRequestLog = [{ url: 'https://shop.example.com/api/orders/77', start: 100, traceId: 'a'.repeat(32), method: 'POST', status: 201 }]
  f.emit('resource', [
    { name: 'https://shop.example.com/api/orders/77', initiatorType: 'fetch', startTime: 110, duration: 420, responseStart: 400, responseStatus: 201, transferSize: 900 },
    { name: 'https://ingest.example.com/v1/traces', initiatorType: 'fetch', startTime: 120, duration: 50 },
    { name: 'https://api.example.com/search?q=shoes', initiatorType: 'xmlhttprequest', startTime: 130, duration: 80, responseStatus: 500 },
    { name: 'https://api.example.com/third', initiatorType: 'fetch', startTime: 140, duration: 10 },
    { name: 'https://cdn.example.com/x.png', initiatorType: 'img', startTime: 150, duration: 10 },
  ])
  const r = f.events('rum_request')
  assert.equal(r.length, 2)
  assert.deepEqual([r[0].properties.method, r[0].properties.path, r[0].properties.status, r[0].properties.traceId, r[0].requestId],
    ['POST', '/api/orders/:id', 201, 'a'.repeat(32), 'a'.repeat(32)])
  assert.equal(r[0].properties.ttfbMs, 290)
  assert.equal(r[0].properties.endpoint, 'POST shop.example.com/api/orders/:id')
  assert.equal(r[1].properties.endpoint, 'unknown api.example.com/search')
  assert.deepEqual([r[1].properties.method, r[1].properties.host, r[1].properties.path, r[1].properties.status, r[1].requestId ?? undefined],
    ['unknown', 'api.example.com', '/search', 500, undefined])
  f.clean()
})

test('long tasks are summed once, when the page is hidden', () => {
  const f = fixture()
  f.emit('longtask', [{ duration: 120 }, { duration: 70 }, { duration: 300 }])
  assert.equal(f.events('rum_long_tasks').length, 0)
  f.scope.document.visibilityState = 'hidden'
  f.docListeners.get('visibilitychange')()
  f.listeners.get('pagehide')()
  const t = f.events('rum_long_tasks')
  assert.equal(t.length, 1)
  assert.deepEqual([t[0].properties.count, t[0].properties.totalBlockingMs, t[0].properties.longestMs], [3, 340, 300])
  f.clean()
})

test('switching requests, resources and long tasks off collects none of them', () => {
  const f = fixture({ requests: false, resources: false, longTasks: false }, { navigation: nav, resources: [{ name: 'https://cdn/x.js', initiatorType: 'script', duration: 5 }] })
  f.emit('resource', [{ name: 'https://shop.example.com/api', initiatorType: 'fetch', startTime: 1, duration: 1 }])
  f.emit('longtask', [{ duration: 500 }])
  f.listeners.get('pagehide')?.()
  assert.equal(f.events('rum_request').length + f.events('rum_resource').length + f.events('rum_long_tasks').length, 0)
  assert.equal(f.events('rum_navigation').length, 1)
  f.clean()
})
