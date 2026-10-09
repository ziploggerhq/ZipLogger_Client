import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ZipLoggerClient, mapLevel } = require('../index.js')

let server
let requests
let responses // queued status codes; default 202

beforeEach(async () => {
  requests = []
  responses = []
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const status = responses.length ? responses.shift() : 202
      requests.push({
        path: req.url,
        apiKey: req.headers['x-api-key'],
        lines: body.split('\n').filter(Boolean).map((l) => JSON.parse(l)),
        status,
      })
      if (status === 429) res.setHeader('Retry-After', '0')
      res.statusCode = status
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterEach(() => server.close())

function makeClient(overrides = {}) {
  return new ZipLoggerClient({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    apiKey: 'zk_test',
    flushIntervalMs: 30,
    retryBaseDelayMs: 10,
    trackSessions: false, // sessions have their own tests (sessions.test.mjs)
    ...overrides,
  })
}

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve() }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('timeout')) }
    }, 10)
  })
}

test('batches entries as NDJSON with API key and enrichment', async () => {
  const client = makeClient({ source: 'unit-test', release: '1.2.3', commitSha: 'abc1234' })
  for (let i = 0; i < 5; i++) client.log({ severity: 'info', message: `event ${i}`, fields: { i } })
  await client.close()

  assert.equal(requests.length, 1)
  const req = requests[0]
  assert.equal(req.path, '/ingest/v1/logs')
  assert.equal(req.apiKey, 'zk_test')
  assert.equal(req.lines.length, 5)
  const first = req.lines[0]
  assert.equal(first.message, 'event 0')
  assert.equal(first.severity, 'info')
  assert.equal(first.source, 'unit-test')
  assert.equal(first.release, '1.2.3')
  assert.equal(first.commitSha, 'abc1234')
  assert.equal(first.fields.i, 0)
  assert.ok(first.fields.machineName)
  assert.ok(first.timestamp)
})

test('error objects map to stackTrace and exception fields', async () => {
  const client = makeClient()
  client.log({ severity: 'error', message: 'it failed', error: new TypeError('boom') })
  await client.close()

  const entry = requests[0].lines[0]
  assert.match(entry.stackTrace, /TypeError: boom/)
  assert.equal(entry.fields.exceptionType, 'TypeError')
  assert.equal(entry.fields.exceptionMessage, 'boom')
})

test('retries on 429 then succeeds without dropping', async () => {
  responses = [429, 429, 202]
  const client = makeClient()
  client.log({ severity: 'info', message: 'retry me' })
  await waitFor(() => requests.length >= 3)
  await client.close()

  assert.deepEqual(requests.map((r) => r.status), [429, 429, 202])
  assert.equal(client.dropped, 0)
  assert.equal(requests[0].lines[0].message, requests[2].lines[0].message)
})

test('drops the batch after max retries', async () => {
  responses = [500, 500, 500]
  const client = makeClient({ maxRetries: 2 })
  client.log({ severity: 'info', message: 'doomed' })
  await waitFor(() => client.dropped >= 1)
  assert.equal(requests.length, 3) // initial + 2 retries
  await client.close()
})

test('non-transient errors do not retry', async () => {
  responses = [401]
  const client = makeClient()
  client.log({ severity: 'info', message: 'bad key' })
  await waitFor(() => client.dropped >= 1)
  assert.equal(requests.length, 1)
  await client.close()
})

test('queue overflow drops instead of blocking', async () => {
  const client = makeClient({ queueCapacity: 3, flushIntervalMs: 60_000 })
  const started = Date.now()
  for (let i = 0; i < 50; i++) client.log({ severity: 'info', message: `burst ${i}` })
  assert.ok(Date.now() - started < 500, 'log() must not block')
  assert.ok(client.dropped >= 47)
  await client.close()
})

test('large volumes split into batches of batchSize', async () => {
  const client = makeClient({ batchSize: 10 })
  for (let i = 0; i < 25; i++) client.log({ severity: 'info', message: `m${i}` })
  await client.close()

  const sizes = requests.map((r) => r.lines.length)
  assert.equal(sizes.reduce((a, b) => a + b, 0), 25)
  assert.ok(Math.max(...sizes) <= 10)
})

test('mapLevel handles pino numbers and common names', () => {
  assert.equal(mapLevel(20), 'debug')
  assert.equal(mapLevel(30), 'info')
  assert.equal(mapLevel(40), 'warn')
  assert.equal(mapLevel(50), 'error')
  assert.equal(mapLevel(60), 'fatal')
  assert.equal(mapLevel('warning'), 'warn')
  assert.equal(mapLevel('verbose'), 'debug')
  assert.equal(mapLevel('critical'), 'fatal')
  assert.equal(mapLevel('nonsense'), 'info')
})
