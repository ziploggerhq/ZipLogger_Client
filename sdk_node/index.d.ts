export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface ZipLoggerOptions {
  /** Base URL of the ZipLogger server, e.g. "https://logs.yourcompany.com". */
  endpoint: string
  /** Tenant ingestion API key (zk_...). */
  apiKey: string
  /** Application/source name. Default: script name or ZIPLOGGER_SOURCE. */
  source?: string
  /** Release/version. Default: nearest package.json version or ZIPLOGGER_RELEASE. */
  release?: string
  /** Git commit SHA. Default: ZIPLOGGER_COMMIT_SHA / GIT_COMMIT / COMMIT_SHA. */
  commitSha?: string
  /** Deployment environment. Default: ZIPLOGGER_ENVIRONMENT / NODE_ENV / "production". */
  environment?: string
  /** Tags added to every entry. */
  tags?: string[]
  /** Max buffered entries before new ones are dropped. Default 10000. */
  queueCapacity?: number
  /** Max entries per HTTP request. Default 100. */
  batchSize?: number
  /** Linger before flushing a partial batch. Default 2000. */
  flushIntervalMs?: number
  /** Retry attempts per batch. Default 5. */
  maxRetries?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  /** Per-request HTTP timeout. Default 10000. */
  timeoutMs?: number
  /**
   * Release health: one session per process (start, first error, exit, crash) sent to /ingest/v1/sessions when a
   * release is known. A crash is reported synchronously by a short-lived child process (at most 3 s). Default true.
   */
  trackSessions?: boolean
  /** Who the session belongs to, for crash-free users (e.g. a user or tenant id). Default: none. */
  sessionDistinctId?: string
}

export interface LogEntry {
  message: string
  severity?: Severity
  timestamp?: string
  source?: string
  release?: string
  commitSha?: string
  stackTrace?: string
  /** Error whose stack/name/message are mapped automatically. */
  error?: Error
  fields?: Record<string, unknown>
  tags?: string[]
}

export declare class ZipLoggerClient {
  constructor(options: ZipLoggerOptions)
  /** Entries lost to backpressure or exhausted retries. */
  dropped: number
  /** Queue an entry for background delivery. Never blocks, never throws. */
  log(entry: LogEntry): void
  /** Send anything still buffered. */
  flush(): Promise<void>
  /** Flush (bounded by timeoutMs), end the release-health session and stop accepting entries. */
  close(timeoutMs?: number): Promise<void>
  /** This process's release-health session status ('ok', 'exited', 'crashed'), or null when not tracked. */
  readonly sessionStatus: 'ok' | 'exited' | 'crashed' | null
}

export declare function mapLevel(level: string | number): Severity
