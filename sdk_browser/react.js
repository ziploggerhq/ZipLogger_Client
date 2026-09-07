/**
 * React integration for @ziplogger/browser.
 *
 * The factory pattern keeps this package dependency-free — pass your React in:
 *
 *   import React from 'react'
 *   import { ZipLoggerBrowser } from '@ziplogger/browser'
 *   import { createErrorBoundary } from '@ziplogger/browser/react'
 *
 *   const ziplogger = new ZipLoggerBrowser({ endpoint: '...', apiKey: 'zk_...' })
 *   const ZipLoggerErrorBoundary = createErrorBoundary(React, ziplogger)
 *
 *   <ZipLoggerErrorBoundary fallback={<p>Something went wrong.</p>}>
 *     <App />
 *   </ZipLoggerErrorBoundary>
 */

/**
 * @param {typeof import('react')} React
 * @param {import('./index').ZipLoggerBrowser} client
 */
export function createErrorBoundary(React, client) {
  return class ZipLoggerErrorBoundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { hasError: false }
    }

    static getDerivedStateFromError() {
      return { hasError: true }
    }

    componentDidCatch(error, info) {
      client.log({
        severity: 'error',
        message: `React error boundary: ${error && error.message ? error.message : String(error)}`,
        error: error instanceof Error ? error : undefined,
        fields: {
          componentStack: info && info.componentStack ? String(info.componentStack).trim() : undefined,
          boundary: this.props.name || 'ZipLoggerErrorBoundary',
        },
      })
      if (this.props.onError) this.props.onError(error, info)
    }

    render() {
      if (this.state.hasError) return this.props.fallback ?? null
      return this.props.children
    }
  }
}

/** Convenience hook factory: stable callbacks for logging, error capture and events. */
export function createUseZipLogger(React, client) {
  return function useZipLogger() {
    return React.useMemo(() => ({
      captureError: (error, fields) => client.captureError(error, fields),
      log: (entry) => client.log(entry),
      track: (name, properties, options) => client.track(name, properties, options),
      identify: (userId, properties) => client.identify(userId, properties),
    }), [])
  }
}
