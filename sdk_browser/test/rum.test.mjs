import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ZipLoggerBrowser } from '../index.js'
import { attachRumCore } from '../rum-core.js'

function fixture(options = {}) {
  const client = new ZipLoggerBrowser({ endpoint: 'http://localhost:9876', apiKey: 'fixture',
    sessionId: 'rum-test-session', flushIntervalMs: 60000 })
  const callbacks = [], handlers = new Map(), tasks = new Map()
  const document = { visibilityState: 'visible', documentElement: {},
    addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) }
  const scope = { document, addEventListener() {}, removeEventListener() {},
    setTimeout(fn) { const id = tasks.size + 1; tasks.set(id, fn); return id }, clearTimeout(id) { tasks.delete(id) } }
  const vitals = Object.fromEntries(['onCLS', 'onINP', 'onLCP'].map(n => [n, fn => callbacks.push(fn)]))
  const rum = attachRumCore(client, options, vitals, scope)
  const clean = () => { rum.stop(); clearTimeout(client._eventTimer); client._events = [] }
  return { client, rum, callbacks, handlers, tasks, scope, vitals, clean }
}
test('consent gates initialization, queued transmission and later library callbacks', () => {
  const f = fixture({ enabled: true })
  assert.equal(f.rum.state, 'no_consent'); assert.equal(f.callbacks.length, 0)
  f.rum.setConsent(true); assert.equal(f.callbacks.length, 3)
  f.callbacks[0]({ name: 'CLS', id: 'visit-a', value: .2 }); assert.equal(f.client._events.length, 1)
  f.rum.setConsent(false); assert.equal(f.client._events.length, 0)
  f.callbacks[0]({ name: 'CLS', id: 'visit-a', value: .3 }); assert.equal(f.client._events.length, 0)
  f.rum.setConsent(true); assert.equal(f.callbacks.length, 3)
  f.clean()
})
test('zero session sampling registers no collectors and attachment is idempotent', () => {
  const f = fixture({ enabled: true, hasConsent: true, sampleRate: 0 })
  assert.equal(f.rum.state, 'not_sampled'); assert.equal(f.callbacks.length, 0)
  assert.equal(attachRumCore(f.client, {}, f.vitals, f.scope), f.rum)
  f.clean()
})

test('one document shares observers and receives synchronous initial callbacks', () => {
  const f = fixture({ enabled: true, hasConsent: true })
  const second = new ZipLoggerBrowser({ endpoint: 'http://localhost:9876', apiKey: 'fixture', sessionId: 'second', flushIntervalMs: 60000 })
  const rum = attachRumCore(second, { enabled: true, hasConsent: true }, f.vitals, f.scope)
  assert.equal(f.callbacks.length, 3)
  f.callbacks[0]({ name: 'CLS', id: 'shared', value: .2 })
  assert.equal(second._events.length, 1)
  f.clean(); f.callbacks[0]({ name: 'CLS', id: 'shared', value: .3 })
  assert.equal(f.client._events.length, 0); assert.equal(second._events.length, 2)
  rum.stop(); clearTimeout(second._eventTimer); second._events = []
  const initial = fixture({ enabled: false })
  // A new document registration can report a buffered result synchronously.
  initial.scope.document = { ...initial.scope.document }
  const controller = attachRumCore(second, {}, initial.vitals, initial.scope)
  assert.equal(controller, rum)
  const third = new ZipLoggerBrowser({ endpoint: 'http://localhost:9876', apiKey: 'fixture', sessionId: 'third', flushIntervalMs: 60000 })
  const sync = attachRumCore(third, { enabled: true, hasConsent: true }, {
    onCLS(fn) { fn({ name: 'CLS', id: 'buffered', value: .1 }) }, onLCP() {}, onINP() {},
  }, initial.scope)
  assert.equal(third._events.length, 1)
  sync.stop(); clearTimeout(third._eventTimer); third._events = []; initial.clean()
})

test('session sampling is stable, covers a deterministic cohort, and invalid rates fail closed', () => {
  let sampled = 0
  for (let i = 0; i < 1000; i++) {
    const state = () => attachRumCore({ identity: { sessionId: `cohort-${i}` }, _detach: [], _events: [] },
      { enabled: true, hasConsent: true, sampleRate: .25 }, {}, {}).state
    const a = state(); assert.equal(state(), a)
    if (a === 'collecting') sampled++
  }
  assert.ok(sampled >= 220 && sampled <= 280, `unexpected fixture coverage: ${sampled}`)
  for (const sampleRate of [NaN, Infinity, '1']) {
    const f = fixture({ enabled: true, hasConsent: true, sampleRate })
    assert.equal(f.rum.state, 'not_sampled'); f.clean()
  }
})
test('updates preserve observation ID/time; BFCache IDs remain separate; limits and invalid metrics are enforced', () => {
  const f = fixture({ enabled: true, hasConsent: true, maxEventsPerPage: 3, getRoute: () => '/checkout?secret=fixture' })
  const callback = f.callbacks[0]
  callback({ name: 'CLS', id: 'visit-a', value: .1 }); callback({ name: 'CLS', id: 'visit-a', value: .2 })
  callback({ name: 'CLS', id: 'visit-b', value: .3 }); callback({ name: 'CLS', id: 'visit-c', value: .4 })
  const [a, b, c] = f.client._events
  assert.equal(f.client._events.length, 3); assert.equal(a.insertId, b.insertId)
  assert.equal(a.timestamp, b.timestamp); assert.notEqual(a.insertId, c.insertId)
  assert.equal(a.properties.route, '/checkout'); assert.equal(a.properties.unit, 'score')
  assert.match(a.properties.metricId, /^vital_[a-p]+$/)
  assert.equal(a.url, undefined); assert.equal(a.page, undefined); assert.equal(a.requestId, undefined)
  assert.equal(a.sessionId, 'rum-test-session'); f.clean()
  const invalid = fixture({ enabled: true, hasConsent: true })
  invalid.callbacks[0]({ name: 'INP', id: 'invalid', value: NaN })
  invalid.callbacks[0]({ name: 'INP', id: 'invalid', value: -1 })
  assert.equal(invalid.client._events.length, 0); invalid.clean()
})
test('frustration requires marked targets and activity cancels dead-click classification', () => {
  const f = fixture({ enabled: true, hasConsent: true, frustration: true })
  const target = { matches: () => false, getAttribute: () => 'checkout_submit', hasAttribute: () => true }
  const event = { isTrusted: true, clientX: 20, clientY: 20, target: { closest: () => target } }
  const click = f.handlers.get('click')
  click(event); f.rum.notifyActivity(); assert.equal(f.tasks.size, 0)
  click(event); click(event)
  assert.equal(f.client._events[0].properties.kind, 'rage_click')
  for (const fn of f.tasks.values()) fn()
  assert.equal(f.client._events[1].properties.kind, 'dead_click')
  assert.equal(f.client._events[1].properties.relationship, 'heuristic')
  f.rum.setConsent(false); click(event); assert.equal(f.client._events.length, 0)
  f.clean(); assert.equal(f.handlers.size, 0)
})
