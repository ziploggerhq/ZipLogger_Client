const controllers = new WeakMap()
const collectors = new WeakMap()
const names = new Set(['LCP', 'INP', 'CLS', 'FCP', 'TTFB'])

/** Ids in a path become ':id', so one endpoint is one row however many orders, users or files it serves. */
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|[A-Za-z0-9_-]{24,})$/i
export function templatePath(path) {
  const clean = String(path || '/').split(/[?#]/)[0]
  return clean.split('/').map(s => (s && ID_SEGMENT.test(s) ? ':id' : s)).join('/').slice(0, 300) || '/'
}
/** Origin and templated path; no query, no fragment, nothing else of the URL. */
export function describeUrl(url, base) {
  try {
    const u = new URL(url, base)
    return { host: u.host.slice(0, 200), path: templatePath(u.pathname) }
  } catch { return { host: '', path: templatePath(url) } }
}
const ms = v => (Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : undefined)
const span = (end, start) => (Number.isFinite(end) && Number.isFinite(start) && end > 0 && start > 0 && end >= start ? ms(end - start) : undefined)
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
  // Requests and resources have budgets of their own, so a chatty page cannot crowd out the vitals that are only
  // final when the page is hidden.
  const cap = (v, d, max) => (Number.isInteger(v) ? Math.max(0, Math.min(max, v)) : d)
  const requestLimit = options.requests === false ? 0 : cap(options.maxRequests, 30, 200)
  const resourceLimit = options.resources === false ? 0 : cap(options.maxResources, 10, 50)
  let requestsSent = 0
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
      vitals.onFCP?.(dispatch, { reportSoftNavs: false }); vitals.onTTFB?.(dispatch, { reportSoftNavs: false })
    }
    collector.add(metric)
    detach.push(() => collector.delete(metric))
    const navigation = () => {
      if (navigationSent || !allowed()) return
      const n = scope.performance?.getEntriesByType('navigation')?.[0]
      if (!n || !Number.isFinite(n.duration) || n.duration <= 0) return
      // Phases of the page load, in milliseconds, for the waterfall: each is absent when the browser did not
      // measure it (a cached or cross-origin redirect, a reused connection).
      navigationSent = emit('rum_navigation', { route: pageRoute, durationMs: ms(n.duration),
        domContentLoadedMs: ms(n.domContentLoadedEventEnd), navigationType: n.type ?? 'unknown',
        redirectMs: span(n.redirectEnd, n.redirectStart), dnsMs: span(n.domainLookupEnd, n.domainLookupStart),
        connectMs: span(n.connectEnd, n.connectStart), tlsMs: span(n.connectEnd, n.secureConnectionStart),
        requestMs: span(n.responseStart, n.requestStart), responseMs: span(n.responseEnd, n.responseStart),
        ttfbMs: ms(n.responseStart), domInteractiveMs: ms(n.domInteractive),
        loadMs: n.loadEventEnd > 0 ? ms(n.loadEventEnd) : undefined,
        transferSize: Number.isFinite(n.transferSize) ? n.transferSize : undefined })
      if (navigationSent) resources()
    }
    // The slowest assets of the page load (scripts, styles, images, fonts), as of when the page has loaded.
    const resources = () => {
      if (resourceLimit === 0 || !allowed()) return
      const entries = (scope.performance?.getEntriesByType?.('resource') ?? [])
        .filter(e => !['fetch', 'xmlhttprequest', 'beacon'].includes(e.initiatorType) && !ownTraffic(e.name))
        .sort((a, b) => b.duration - a.duration).slice(0, resourceLimit)
      for (const e of entries) {
        const { host, path } = describeUrl(e.name, scope.location?.href)
        client.track('rum_resource', { schema: 1, zlCollection: 'rum', sampleRate: rate, route: pageRoute, host, path,
          resource: `${host}${path}`.slice(0, 300),
          initiator: e.initiatorType || 'other', durationMs: ms(e.duration), transferSize: e.transferSize,
          renderBlocking: e.renderBlockingStatus ?? 'unknown', cached: e.transferSize === 0 && e.decodedBodySize > 0 },
        { requestId: null, includePageContext: false })
      }
    }
    // Fetch and XHR timings from the browser's own resource entries: nothing is wrapped. A request instrumentFetch
    // traced carries its trace id (matched on URL and start time), which links it to the backend trace.
    const ingestOrigin = String(client._url || '').split('/').slice(0, 3).join('/')
    const ownTraffic = name => ingestOrigin.length > 0 && String(name).startsWith(ingestOrigin)
      && /\/(ingest|v1)\//.test(String(name).slice(ingestOrigin.length))
    const request = (e) => {
      if (requestsSent >= requestLimit || !allowed() || !['fetch', 'xmlhttprequest'].includes(e.initiatorType) || ownTraffic(e.name)) return
      const traced = (client._rumRequestLog ?? []).find(r => r.url === e.name && Math.abs(r.start - e.startTime) < 100)
      const { host, path } = describeUrl(e.name, scope.location?.href)
      const status = e.responseStatus > 0 ? e.responseStatus : traced?.status
      requestsSent++
      const method = traced?.method ?? 'unknown'
      client.track('rum_request', { schema: 1, zlCollection: 'rum', sampleRate: rate, route: route(), host, path,
        // One key per endpoint, for grouping: method, host and templated path.
        endpoint: `${method} ${host}${path}`.slice(0, 300), method, status: status ?? 0, durationMs: ms(e.duration),
        ttfbMs: span(e.responseStart, e.startTime) ?? undefined, transferSize: e.transferSize, initiator: e.initiatorType,
        ...(traced?.traceId ? { traceId: traced.traceId } : {}) },
      { requestId: traced?.traceId ?? null, includePageContext: false })
    }
    // Long tasks (Chromium): how long the main thread was blocked over the page's life, sent once when it is hidden.
    let longTasks = { count: 0, blockingMs: 0, longestMs: 0 }, longTasksSent = false
    const sendLongTasks = () => {
      if (longTasksSent || longTasks.count === 0 || !allowed()) return
      longTasksSent = emit('rum_long_tasks', { route: pageRoute, count: longTasks.count,
        totalBlockingMs: ms(longTasks.blockingMs), longestMs: ms(longTasks.longestMs) })
    }
    const observers = []
    const observe = (type, onEntry) => {
      try {
        if (!scope.PerformanceObserver?.supportedEntryTypes?.includes(type)) return
        const o = new scope.PerformanceObserver(list => { for (const e of list.getEntries()) onEntry(e) })
        o.observe({ type, buffered: true })
        observers.push(o)
      } catch { /* an entry type this browser does not have */ }
    }
    if (requestLimit > 0) observe('resource', request)
    if (options.longTasks !== false) observe('longtask', e => {
      longTasks.count++; longTasks.blockingMs += Math.max(0, e.duration - 50); longTasks.longestMs = Math.max(longTasks.longestMs, e.duration)
    })
    const onHidden = () => { if (scope.document?.visibilityState === 'hidden') sendLongTasks() }
    scope.document.addEventListener?.('visibilitychange', onHidden)
    scope.addEventListener?.('pagehide', sendLongTasks)
    detach.push(() => {
      for (const o of observers.splice(0)) o.disconnect()
      scope.document.removeEventListener?.('visibilitychange', onHidden); scope.removeEventListener?.('pagehide', sendLongTasks)
    })
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
