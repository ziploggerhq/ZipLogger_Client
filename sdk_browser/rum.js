import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals'
import { attachRumCore } from './rum-core.js'

/** Optional entry: load only after deciding to enable browser experience collection. */
export function attachRum(client, options = {}) {
  return attachRumCore(client, options, { onCLS, onINP, onLCP, onFCP, onTTFB })
}
