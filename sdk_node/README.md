# ziplogger (Node.js)

Node.js SDK for [ZipLogger](https://ziplogger.ai) — a zero-dependency core client
plus **Pino** and **Winston** transports. Batching, retry with backoff (429-aware),
drop-on-backpressure, automatic enrichment. Node ≥ 18.

```bash
npm install ziplogger
```

## Pino

```js
const pino = require('pino')

const logger = pino(pino.transport({
  target: 'ziplogger/pino',
  options: { endpoint: 'https://app.ziplogger.ai', apiKey: 'zk_...' },
}))

logger.info({ orderId: 83112, customer: 'acme' }, 'Order created')
logger.error({ err }, 'Payment failed')   // err.stack → ZipLogger stackTrace
```

Requires `pino-abstract-transport` (`npm i pino pino-abstract-transport`).

## Winston

```js
const winston = require('winston')
const { ZipLoggerTransport } = require('ziplogger/winston')

const logger = winston.createLogger({
  transports: [
    new ZipLoggerTransport({ endpoint: 'https://app.ziplogger.ai', apiKey: 'zk_...' }),
  ],
})

logger.info('Order created', { orderId: 83112 })
```

## Core client (any framework, or none)

```js
const { ZipLoggerClient } = require('ziplogger')

const zl = new ZipLoggerClient({ endpoint: 'https://app.ziplogger.ai', apiKey: 'zk_...' })
zl.log({ severity: 'info', message: 'job finished', fields: { jobId: 42 } })
zl.log({ severity: 'error', message: 'job failed', error: err })
await zl.close()   // flush on shutdown
```

## Behavior

`log()` never blocks and never throws. Entries buffer in a bounded queue (default 10,000),
ship as NDJSON batches (default 100 per request, 2s linger) to `/ingest/v1/logs`, retry
transient failures (429 honoring `Retry-After`, 5xx, network) with exponential backoff, and
drop with a counter (`client.dropped`) when the queue overflows or retries exhaust. Timers are
`unref`ed — the SDK never keeps your process alive. Every entry is enriched with
`environment`, `machineName`, `release` (nearest package.json), and `commitSha`
(`GIT_COMMIT`/`COMMIT_SHA` env vars) — the inputs to ZipLogger's git regression detection.

## Release health

When a release is known (option, `ZIPLOGGER_RELEASE`, or the nearest package.json version), the client reports one
session per process to `/ingest/v1/sessions`: when it starts, at its first error-level log, when it ends normally
(`close()`, or the event loop draining) and as **crashed** when an uncaught exception or unhandled rejection is about
to end the process. The crash update is sent synchronously by a short-lived child process (at most 3 seconds) through
`uncaughtExceptionMonitor`, so how your process crashes does not change. ZipLogger shows crash-free sessions per release
under Issues → Releases.

```js
const zl = new ZipLoggerClient({ endpoint, apiKey, release: 'api@2.4.0', sessionDistinctId: tenantId })
zl.sessionStatus   // 'ok', later 'exited' or 'crashed'
```

`sessionDistinctId` (optional) counts crash-free users. `trackSessions: false` turns sessions off. A process ended with
`process.exit()` keeps its last status (not crashed).

## The `ziplogger` CLI: releases, deploys and source maps from CI

The package includes a command line for CI (0.6.0 and later). It needs a key with the **CI: releases and source maps**
permission (Settings → API keys), created in the environment you deploy to.

```bash
export ZIPLOGGER_API_KEY=zk_...      # a CI secret
VERSION="web@$(git rev-parse --short HEAD)"
npx ziplogger releases new "$VERSION" --service web        # commit + commits since the previous release
npx ziplogger sourcemaps upload ./dist --release "$VERSION" --url-prefix "~/assets/"
npx ziplogger releases finalize "$VERSION" --service web
npx ziplogger releases deploy "$VERSION" --service web --name "deploy #42"
```

`releases new` sends `git rev-parse HEAD` and `git log <previous release's commit>..HEAD`. In a shallow clone it
sends only the commit and ZipLogger reads the range from the connected GitHub or GitLab repository. `ziplogger --help`
lists every option; [docs/releases.md](../docs/releases.md) has the details.
