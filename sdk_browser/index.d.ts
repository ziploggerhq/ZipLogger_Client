export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

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
