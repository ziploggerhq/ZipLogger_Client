import type { ZipLoggerBrowser } from './index.js'
export interface RumOptions {
  /** Default false. RUM is separate from replay consent/settings. */
  enabled?: boolean
  /** Default false. No observers or events until consent is true. */
  hasConsent?: boolean
  /** Deterministic per session. Default 1, range 0..1. */
  sampleRate?: number
  /** Return a route template, e.g. /orders/:id. Raw URLs/text are not read. Default [unmapped]. */
  getRoute?: () => string
  /** Explicit opt-in heuristics on data-ziplogger-action elements; default false. */
  frustration?: boolean
  /** Updates count toward this cap. Default 100; maximum 1000. Requests and resources have their own caps. */
  maxEventsPerPage?: number
  /** Fetch/XHR timings (rum_request) from the browser's resource entries. Default true. */
  requests?: boolean
  /** rum_request events per page. Default 30; maximum 200. */
  maxRequests?: number
  /** The slowest page-load assets (rum_resource). Default true. */
  resources?: boolean
  /** rum_resource events per page. Default 10; maximum 50. */
  maxResources?: number
  /** Main-thread blocking (rum_long_tasks, Chromium), sent once when the page is hidden. Default true. */
  longTasks?: boolean
}
export interface RumController {
  setConsent(value: boolean): void
  notifyActivity(): void
  stop(): void
  readonly state: 'stopped' | 'disabled' | 'no_consent' | 'not_sampled' | 'collecting'
  readonly emitted: number
}
export declare function attachRum(client: ZipLoggerBrowser, options?: RumOptions): RumController
