import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ZipLoggerClient } = require('../index.js')
const indexPath = fileURLToPath(new URL('../index.js', import.meta.url))

let server
let sessions // every session update received, in order
let logs

beforeEach(async () => {
  sessions = []
  logs = []
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (req.url === '/ingest/v1/sessions') sessions.push(...JSON.parse(body).map((s) => ({ ...s, apiKey: req.headers['x-api-key'] })))
      else logs.push(body)
      res.statusCode = 202
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterEach(() => server.close())

const endpoint = () => `http://127.0.0.1:${server.address().port}`

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve() }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('timeout')) }
    }, 10)
  })
}

test('a session starts, sends one update for its first errors, and exits on close', async () => {
  const client = new ZipLoggerClient({ endpoint: endpoint(), apiKey: 'zk_test', release: 'api@2.0.0', environment: 'staging',
    sessionDistinctId: 'tenant-7', flushIntervalMs: 20 })
  await waitFor(() => sessions.length === 1)
  assert.equal(client.sessionStatus, 'ok')
  client.log({ severity: 'error', message: 'payment failed' })
  client.log({ severity: 'fatal', message: 'still failing' })
  await waitFor(() => sessions.length === 2)
  await client.close()
  // One update for the first error; it carries the count when it is sent (both errors were logged by then).
  assert.deepEqual(sessions.map((s) => [s.status, s.errors]), [['ok', 0], ['ok', 2], ['exited', 2]])
  const [first] = sessions
  assert.equal(new Set(sessions.map((s) => s.sid)).size, 1)
  assert.deepEqual([first.did, first.attrs, first.apiKey], ['tenant-7', { release: 'api@2.0.0', environment: 'staging' }, 'zk_test'])
  assert.equal(client.sessionStatus, 'exited')
})

test('no release or trackSessions: false means no session', async () => {
  const off = new ZipLoggerClient({ endpoint: endpoint(), apiKey: 'zk_test', release: 'api@2.0.0', trackSessions: false })
  off.log({ severity: 'error', message: 'x' })
  await off.close()
  assert.equal(off.sessionStatus, null)
  assert.equal(sessions.length, 0)
})

function runChild(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('exit', (code) => resolve({ code, stderr }))
  })
}

test('an uncaught exception reports a crashed session before the process dies, and still crashes', async () => {
  const { code, stderr } = await runChild(`
    const { ZipLoggerClient } = require(${JSON.stringify(indexPath)})
    new ZipLoggerClient({ endpoint: ${JSON.stringify(endpoint())}, apiKey: 'zk_test', release: 'worker@1.0.0' })
    setTimeout(() => { throw new Error('boom') }, 200)`)
  assert.notEqual(code, 0)
  assert.match(stderr, /boom/)
  await waitFor(() => sessions.some((s) => s.status === 'crashed'))
  assert.deepEqual(sessions.map((s) => [s.status, s.errors]), [['ok', 0], ['crashed', 1]])
})

test('a process that finishes its work exits its session without close()', async () => {
  const { code } = await runChild(`
    const { ZipLoggerClient } = require(${JSON.stringify(indexPath)})
    new ZipLoggerClient({ endpoint: ${JSON.stringify(endpoint())}, apiKey: 'zk_test', release: 'job@1.0.0' })`)
  assert.equal(code, 0)
  await waitFor(() => sessions.some((s) => s.status === 'exited'))
  assert.deepEqual(sessions.map((s) => s.status), ['ok', 'exited'])
})
