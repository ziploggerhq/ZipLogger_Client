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
  /** Updates count toward this cap. Default 100; maximum 1000. */
  maxEventsPerPage?: number
}
export interface RumController {
  setConsent(value: boolean): void
  notifyActivity(): void
  stop(): void
  readonly state: 'stopped' | 'disabled' | 'no_consent' | 'not_sampled' | 'collecting'
  readonly emitted: number
}
export declare function attachRum(client: ZipLoggerBrowser, options?: RumOptions): RumController
