export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/**
 * Session Replay options. Nothing here records anything by itself: the recorder lives in the
 * separate `@ziplogger/browser/replay` entry and only runs after `attachSessionReplay(client)`.
 * The server's answer (plan, workspace settings, platform kill switch) is checked before a
 * single event is captured, and its sample rate, when set, overrides `sampleRate` below.
 */
export interface SessionReplayOptions {
  /** Record this app's sessions. Default false. */
  enabled?: boolean
  /**
   * Share of sessions to record, 0..1, decided once per session (deterministic on the session
   * id, so a reload keeps the same decision). Default 1. A rate set in ZipLogger → Settings →
   * Session replay wins over this value.
   */
  sampleRate?: number
  /**
   * Replace every input and textarea value with asterisks of the same length. Default true.
   * Passwords, one-time codes and payment fields are masked even when this is false.
   */
  maskInputs?: boolean
  /** Mask every text node on the page. For pages that render personal data as plain text. Default false. */
  maskAllText?: boolean
  /** Extra CSS selector whose text is masked, on top of `[data-ziplogger-mask]`. */
  maskSelector?: string | null
  /** Extra CSS selector whose subtree is not recorded at all, on top of `[data-ziplogger-ignore]`. */
  blockSelector?: string | null
  /**
   * Rewrite every URL a recording carries — the page's own address, and the `href`, `src`,
   * `action` and similar attributes of everything on it.
   *
   * Masking covers text and input values. It does not touch attributes, and a URL is an
   * attribute, so an app whose paths carry identifiers (`/users/{email}`, `/orders/{id}`) records
   * them however thoroughly its text is masked. Supply a function that replaces the identifying
   * parts:
   *
   * ```js
   * scrubUrl: (url) => url.replace(/\/users\/[^/?#]+/g, '/users/:id')
   * ```
   *
   * Off by default: it walks every event, which is a cost an app without identifiers in its paths
   * should not pay. A scrubber that throws drops the value rather than passing it through.
   */
  scrubUrl?: ((url: string) => string) | null
  /** Record canvas contents as images. Costly; default false. */
  recordCanvas?: boolean
  /** Stop recording after this many seconds. Default 3600, never more than the server allows. */
  maxSessionSeconds?: number
  /** Stop recording once this many uncompressed bytes have been produced. Default 50 MB. */
  maxSessionBytes?: number
  /** Linger before uploading a partial chunk. Default 5000; the server may lower it. */
  flushIntervalMs?: number
  /** Upload once this many events are buffered. Default 100. */
  flushEvents?: number
  /** Upload once the buffered events reach this many bytes. Default 256 KB. */
  flushBytes?: number
  /** Chunks waiting to upload before recording stops for the session. Default 8. */
  maxPendingChunks?: number
}

export interface SessionReplayController {
  /** Start recording this session if the server and the sampling decision allow it. Idempotent. */
  start(): Promise<void>
  /** Stop recording and send what is buffered as the final chunk. */
  stop(): Promise<void>
  isRecording(): boolean
  /** Events lost to upload failures or backlog. */
  readonly dropped: number
  /** Why recording is not happening, when it is not: `not_sampled`, `disabled`, `unreachable`, `stopped`, … */
  readonly lastReason: string | null
  /** The server's answer to the last configuration request, for debugging. */
  readonly serverConfig: Record<string, unknown> | null
}

export interface BrowserOptions {
  /** Your ZipLogger origin, e.g. "https://app.ziplogger.ai" (or your own host if
   *  you self-host). Paths are appended for you. */
  endpoint: string
  /** Tenant ingestion API key (zk_...). Use a key dedicated to browser traffic. */
  apiKey: string
  /** Source name. Default: window.location.hostname. */
  source?: string
  release?: string
  commitSha?: string
  /** Default "production". */
  environment?: string
  tags?: string[]
  /** Attach url + userAgent to every log line, and url + page to every event. Default true. */
  includePageContext?: boolean
  /** Your id for the signed-in user, when the page already knows it. Otherwise call identify(). */
  userId?: string
  /** Override the generated anonymous id. Normally left alone: it is minted once and kept in
   *  localStorage so a visitor's pre-login events can be linked to their account later. */
  anonymousId?: string
  /** Override the generated session id (per tab, kept in sessionStorage). */
  sessionId?: string
  /** Max buffered events. Default 1000. */
  queueCapacity?: number
  /** Max events per request. Default 20. */
  batchSize?: number
  /** Linger before flushing a partial batch. Default 3000. */
  flushIntervalMs?: number
  /** Retry attempts per batch. Default 2 (browsers should not hammer). */
  maxRetries?: number
  retryBaseDelayMs?: number
  /**
   * How long after an instrumented fetch a `track()` call still inherits its trace id as
   * `requestId`. Default 5000. 0 disables automatic correlation (explicit `requestId` still works).
   */
  requestCorrelationTtlMs?: number
  /**
   * Session Replay. Takes effect only after `attachSessionReplay(client)` from
   * `@ziplogger/browser/replay`; without that import nothing about replay is loaded or sent.
   */
  sessionReplay?: SessionReplayOptions
}

export interface TrackOptions {
  /**
   * The request this event happened in: a W3C trace id (32 lowercase hex) or a full `traceparent`
   * value. Overrides the id inferred from the most recent instrumented fetch. ZipLogger uses it to
   * correlate the event with the logs and traces of that request.
   */
  requestId?: string
}

export interface BrowserLogEntry {
  message: string
  severity?: Severity
  timestamp?: string
  source?: string
  release?: string
  commitSha?: string
  stackTrace?: string
  error?: Error
  fields?: Record<string, unknown>
  tags?: string[]
}

export interface Identity {
  userId: string | null
  anonymousId: string | null
  sessionId: string | null
}

export declare class ZipLoggerBrowser {
  constructor(options: BrowserOptions)
  /** Records lost to backpressure or exhausted retries, logs and events together. */
  dropped: number
  /** The ids events are currently attributed to. */
  readonly identity: Identity
  /**
   * Session Replay controls. Inert until `attachSessionReplay(client)` from
   * `@ziplogger/browser/replay` has run; after that, the live controller.
   */
  sessionReplay: SessionReplayController
  /** Queue an event for background delivery. Never blocks, never throws. */
  log(entry: BrowserLogEntry): void
  /** Report a caught error with optional context fields. */
  captureError(error: unknown, fields?: Record<string, unknown>): void
  /** Capture window error / unhandledrejection events. Returns a stop function. */
  captureGlobalErrors(): () => void
  /**
   * Record a product-analytics event -- a signup, a checkout, a plan change.
   *
   * Distinct from log(): logs are lines you read when something breaks, events are things people
   * did, and ZipLogger answers different questions with each. Never blocks, never throws.
   *
   * Values that look like credentials are redacted server-side; do not send passwords, tokens or
   * card numbers as properties.
   *
   * With `instrumentFetch()` active, the event carries the trace id of the most recent instrumented
   * request (within `requestCorrelationTtlMs`) as `requestId`, so ZipLogger can show the logs and
   * traces of the request the event happened in. Pass `options.requestId` to set it explicitly.
   */
  track(name: string, properties?: Record<string, unknown>, options?: TrackOptions): void
  /**
   * Attach this browser's anonymous history to a real account and use that id from now on.
   * Call once after sign-in; the server links the ids so pre-login events stop being a separate
   * person.
   */
  identify(userId: string, properties?: Record<string, unknown>): void
  /** Forget the signed-in user and start a fresh anonymous identity, e.g. on sign-out. */
  reset(): void
  /**
   * Wraps window.fetch: adds a W3C traceparent header to same-origin requests (plus any
   * origins in propagateTo) so browser calls and backend traces share one trace id, and
   * logs failed requests (HTTP >= 400 / network errors) with that trace id. Each instrumented
   * request also becomes the "most recent request" that a following `track()` links to.
   */
  instrumentFetch(options?: {
    propagateTo?: string[]
    logFailures?: boolean
    /** Export a browser-side root span per request (default true) so the waterfall starts in the browser. */
    sendSpans?: boolean
    /** Service name for browser spans (default "<source>-browser"). */
    serviceName?: string
  }): () => void
  /** Send anything still buffered, logs and events both. keepalive=true during page unload. */
  flush(keepalive?: boolean): Promise<void>
  /** Flush and detach global listeners. */
  close(): Promise<void>
}
export default ZipLoggerBrowser

// ./react
import type * as ReactNamespace from 'react'
export declare function createErrorBoundary(
  React: typeof ReactNamespace,
  client: ZipLoggerBrowser,
): ReactNamespace.ComponentType<{
  children?: ReactNamespace.ReactNode
  fallback?: ReactNamespace.ReactNode
  name?: string
  onError?: (error: unknown, info: { componentStack?: string }) => void
}>
export declare function createUseZipLogger(
  React: typeof ReactNamespace,
  client: ZipLoggerBrowser,
): () => {
  captureError: (error: unknown, fields?: Record<string, unknown>) => void
  log: (entry: BrowserLogEntry) => void
  track: (name: string, properties?: Record<string, unknown>, options?: TrackOptions) => void
  identify: (userId: string, properties?: Record<string, unknown>) => void
}

// ./replay
/**
 * Optional overrides. An app with a bundler passes none of these; a page that loads the SDK from
 * plain `<script type="module">` tags supplies `loadRecorder`, because a browser cannot resolve
 * the bare `@rrweb/record` specifier without a bundler or an import map.
 */
export interface SessionReplayDependencies {
  /** Provides rrweb's `record`. Default: `import('@rrweb/record')`. */
  loadRecorder?: () => Promise<(options: Record<string, unknown>) => (() => void) | undefined>
  fetch?: typeof fetch
  /** gzip a chunk body. `null` sends plain JSON. Default: the browser's CompressionStream. */
  compress?: ((text: string) => Promise<Uint8Array | string>) | null
  now?: () => number
}
/**
 * Wire Session Replay into a client: replaces the inert `client.sessionReplay` with a live
 * controller and starts it when `sessionReplay.enabled` is set. `@rrweb/record` must be
 * installed alongside this package; it is loaded on demand, only for sampled sessions.
 */
export declare function attachSessionReplay(
  client: ZipLoggerBrowser,
  deps?: SessionReplayDependencies,
): SessionReplayController
/** True when a session with this id is recorded at the given rate. Deterministic. */
export declare function sampledIn(sessionId: string, rate: number): boolean
export declare const REPLAY_SDK_VERSION: string
export declare const ALWAYS_MASK_SELECTORS: readonly string[]
export declare const ALWAYS_BLOCK_SELECTORS: readonly string[]
