const controllers = new WeakMap()
const collectors = new WeakMap()
const names = new Set(['LCP', 'INP', 'CLS'])
function fraction(id) {
  let h = 2166136261
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  h ^= h >>> 16; h = Math.imul(h, 0x21f0aaad)
  h ^= h >>> 15; h = Math.imul(h, 0x735a2d97)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Library callbacks are injected here for deterministic lifecycle/privacy tests. */
export function attachRumCore(client, options, vitals, scope = globalThis) {
  if (controllers.has(client)) return controllers.get(client)
  const rate = options.sampleRate === undefined ? 1
    : Number.isFinite(options.sampleRate) ? Math.max(0, Math.min(1, options.sampleRate)) : 0
  const sampled = fraction(client.identity.sessionId ?? '') < rate
  let consent = options.hasConsent === true, stopped = false, initialized = false, sent = 0
  const limit = Number.isInteger(options.maxEventsPerPage) ? Math.max(1, Math.min(1000, options.maxEventsPerPage)) : 100
  const route = () => {
    try { const r = options.getRoute?.(); return typeof r === 'string' && r.length > 0 ? r.slice(0, 200).split(/[?#]/)[0] : '[unmapped]' }
    catch { return '[unmapped]' }
  }
  const allowed = () => options.enabled === true && consent && sampled && !stopped
  const previousLogContext = client._rumLogContext
  const logContext = () => allowed() ? { sessionId: client.identity.sessionId,
    userId: client.identity.userId ?? undefined } : {}
  client._rumLogContext = logContext
  const emit = (name, properties, trackOptions = {}) => {
    if (!allowed() || sent >= limit) return false
    sent++
    client.track(name, { schema: 1, zlCollection: 'rum', sampleRate: rate, ...properties },
      { requestId: null, includePageContext: false, ...trackOptions })
    if (scope.document?.visibilityState === 'hidden') void client.flush(true)
    return true
  }
  const pageRoute = route()
  const observations = new Map()
  const metric = (m) => {
    if (!allowed() || sent >= limit || !names.has(m.name) || !Number.isFinite(m.value) || m.value < 0 || typeof m.id !== 'string') return
    const key = `${m.name}:${m.id}`
    if (!observations.has(key)) observations.set(key, {
      timestamp: new Date().toISOString(),
      // web-vitals IDs contain long digit runs, which the server intentionally masks as
      // potential PII. Use an opaque alphabetic ID so visits cannot collapse after scrubbing.
      id: client._newId('vital').replace(/[0-9]/g, d => String.fromCharCode(103 + Number(d))),
    })
    const observation = observations.get(key)
    emit('web_vital', { metric: m.name, metricId: observation.id, value: m.value,
      unit: m.name === 'CLS' ? 'score' : 'ms', route: pageRoute,
      navigationType: m.navigationType ?? 'unknown', rating: m.rating ?? 'unknown', population: 'sampled_page_visits' },
    { insertId: `rum:${observation.id}`, timestamp: observation.timestamp })
  }
  const detach = []
  let deadTimer = null, clicks = [], navigationSent = false
  const activity = () => { if (deadTimer !== null) { scope.clearTimeout(deadTimer); deadTimer = null } }
  const initialize = () => {
    if (!allowed() || initialized || !scope.document) return
    initialized = true
    // Google requires one registration per document. The library has no stop API; dispatch
    // only to currently attached, consent-gated controllers, and remove stopped subscribers.
    let collector = collectors.get(scope.document)
    if (!collector) {
      collector = new Set()
      collectors.set(scope.document, collector)
      collector.add(metric)
      const dispatch = m => { for (const callback of collector) callback(m) }
      vitals.onLCP(dispatch, { reportSoftNavs: false }); vitals.onINP(dispatch, { reportSoftNavs: false }); vitals.onCLS(dispatch, { reportSoftNavs: false })
    }
    collector.add(metric)
    detach.push(() => collector.delete(metric))
    const navigation = () => {
      if (navigationSent || !allowed()) return
      const n = scope.performance?.getEntriesByType('navigation')?.[0]
      if (!n || !Number.isFinite(n.duration) || n.duration <= 0) return
      navigationSent = emit('rum_navigation', { route: pageRoute, durationMs: n.duration,
        domContentLoadedMs: n.domContentLoadedEventEnd, navigationType: n.type ?? 'unknown' })
    }
    const onLoad = () => scope.setTimeout(navigation, 0)
    scope.addEventListener?.('load', onLoad)
    scope.addEventListener?.('pagehide', navigation)
    detach.push(() => { scope.removeEventListener?.('load', onLoad); scope.removeEventListener?.('pagehide', navigation) })
    navigation()
    if (options.frustration === true) {
      const onClick = (e) => {
        if (!allowed() || e.isTrusted === false) return
        const target = e.target?.closest?.('[data-ziplogger-action]')
        if (!target || target.matches?.('[disabled],[aria-disabled="true"],input,textarea,select')) return
        const action = target.getAttribute('data-ziplogger-action')?.slice(0, 80)
        if (!action) return
        activity()
        const now = Date.now()
        clicks = clicks.filter(c => now - c.at <= 1000 && c.target === target && Math.hypot(c.x - e.clientX, c.y - e.clientY) <= 40)
        clicks.push({ target, at: now, x: e.clientX, y: e.clientY })
        if (clicks.length >= 3) {
          emit('rum_frustration', { kind: 'rage_click', action, route: route(), relationship: 'heuristic',
            definition: '3_clicks_same_target_40px_1000ms' }); clicks = []
        }
        if (target.hasAttribute('data-ziplogger-dead-click')) {
          deadTimer = scope.setTimeout(() => {
            deadTimer = null
            emit('rum_frustration', { kind: 'dead_click', action, route: route(), relationship: 'heuristic',
              definition: 'marked_target_no_observed_activity_1000ms' })
          }, 1000)
        }
      }
      scope.document.addEventListener('click', onClick)
      const observer = scope.MutationObserver ? new scope.MutationObserver(activity) : null
      observer?.observe(scope.document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
      const previousActivity = client._rumActivity
      client._rumActivity = activity
      scope.addEventListener?.('popstate', activity)
      scope.addEventListener?.('hashchange', activity)
      detach.push(() => {
        scope.document.removeEventListener('click', onClick); observer?.disconnect()
        scope.removeEventListener?.('popstate', activity); scope.removeEventListener?.('hashchange', activity)
        if (client._rumActivity === activity) client._rumActivity = previousActivity
      })
    }
  }
  const controller = {
    setConsent(value) {
      consent = value === true
      if (!consent) {
        activity(); clicks = []
        client._events = client._events.filter(e => e.properties?.zlCollection !== 'rum')
      }
      initialize()
    },
    notifyActivity: activity,
    stop() {
      stopped = true; activity(); for (const stop of detach.splice(0)) stop()
      if (client._rumLogContext === logContext) client._rumLogContext = previousLogContext
    },
    get state() { return stopped ? 'stopped' : options.enabled !== true ? 'disabled' : !consent ? 'no_consent' : !sampled ? 'not_sampled' : 'collecting' },
    get emitted() { return sent },
  }
  controllers.set(client, controller)
  client._detach.push(() => controller.stop())
  initialize()
  return controller
}
