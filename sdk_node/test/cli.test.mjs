import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { main, parseArgs, batches, collectFiles } = require('../cli-core.js')

/** A throwaway repository with three commits; returns its path and the shas, oldest first. */
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'zl-cli-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.email', 'ci@example.com'); git('config', 'user.name', 'CI Bot'); git('config', 'commit.gpgsign', 'false')
  const shas = []
  for (const [i, message] of ['Initial', 'Add coupons', 'Fix the cart total'].entries()) {
    writeFileSync(join(dir, `f${i}.txt`), String(i))
    git('add', '.'); git('commit', '-q', '-m', message)
    shas.push(git('rev-parse', 'HEAD'))
  }
  return { dir, shas, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A fake ZipLogger: records requests, answers from a table of handlers keyed by "METHOD path". */
function server(handlers) {
  const calls = []
  const fetch = async (url, init) => {
    const u = new URL(url)
    const key = `${init.method} ${u.pathname}`
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    calls.push({ key, url: u, headers: init.headers, body })
    const h = handlers[key]
    const [status, json] = h ? h(body, u) : [404, { error: 'no handler' }]
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(json) }
  }
  return { fetch, calls }
}

const env = { ZIPLOGGER_API_KEY: 'zk_test', ZIPLOGGER_URL: 'https://zl.example.com' }
const echo = (body) => [200, { version: body.version, service: body.service ?? '', environment: 'production', commitsStatus: body.commits ? 'client' : 'fetched',
  commitCount: body.commits?.length ?? 0, dateReleased: body.finalize ? '2026-10-13T00:00:00Z' : null, commitsError: null }]

test('arguments: flags with and without =, switches and positionals', () => {
  assert.deepEqual(parseArgs(['releases', 'new', 'shop@1', '--service=web', '--finalize', '--ref', 'v1']),
    { flags: { service: 'web', finalize: true, ref: 'v1' }, positional: ['releases', 'new', 'shop@1'] })
  assert.throws(() => parseArgs(['--service']), /needs a value/)
})

test('a new release sends its commit and the commits since the previous release, newest first', async () => {
  const repo = repository()
  try {
    const lines = []
    const s = server({ 'GET /api/v1/releases/latest': () => [200, { commitSha: repo.shas[0] }], 'POST /api/v1/releases': echo })
    const code = await main(['releases', 'new', 'shop@2', '--service', 'web', '--finalize', '--url', 'https://ci.example.com/1'],
      { fetch: s.fetch, env, cwd: repo.dir, out: l => lines.push(l), err: l => lines.push(l) })
    assert.equal(code, 0, lines.join('\n'))
    assert.equal(s.calls[0].url.searchParams.get('excluding'), 'shop@2')
    assert.equal(s.calls[0].url.searchParams.get('service'), 'web')
    assert.equal(s.calls[0].headers['X-Api-Key'], 'zk_test')
    const body = s.calls[1].body
    assert.equal(body.commit, repo.shas[2])
    assert.equal(body.previousCommit, repo.shas[0])
    assert.deepEqual(body.commits.map(c => c.message), ['Fix the cart total', 'Add coupons'])
    assert.equal(body.commits[0].author, 'CI Bot')
    assert.equal(body.finalize, true)
    assert.match(lines.at(-1), /Release shop@2 of web in production: 2 commits, finalized/)
  } finally { repo.cleanup() }
})

test('the first release sends the latest commits; a previous commit missing from a shallow clone is left to the server', async () => {
  const repo = repository()
  try {
    const first = server({ 'GET /api/v1/releases/latest': () => [404, { error: 'none' }], 'POST /api/v1/releases': echo })
    assert.equal(await main(['releases', 'new', 'shop@1'], { fetch: first.fetch, env, cwd: repo.dir, out: () => {} }), 0)
    assert.equal(first.calls[1].body.commits.length, 3)
    assert.equal(first.calls[1].body.previousCommit, undefined)

    const lines = []
    const shallow = server({ 'GET /api/v1/releases/latest': () => [200, { commitSha: 'f'.repeat(40) }], 'POST /api/v1/releases': echo })
    assert.equal(await main(['releases', 'new', 'shop@3'], { fetch: shallow.fetch, env, cwd: repo.dir, out: l => lines.push(l) }), 0)
    assert.equal(shallow.calls[1].body.commits, undefined)
    assert.equal(shallow.calls[1].body.previousCommit, 'f'.repeat(40))
    assert.match(lines[0], /not in this checkout/)

    const none = server({ 'POST /api/v1/releases': echo })
    assert.equal(await main(['releases', 'new', 'shop@4', '--no-commits'], { fetch: none.fetch, env, cwd: repo.dir, out: () => {} }), 0)
    assert.equal(none.calls.length, 1)
    assert.equal(none.calls[0].body.commit, repo.shas[2])
  } finally { repo.cleanup() }
})

test('outside a checkout the release is created without a commit; deploys and finalize map their flags', async () => {
  const s = server({
    'POST /api/v1/releases': echo,
    'POST /api/v1/releases/deploys': (body) => [200, { release: { version: body.version, environment: 'production' }, deploy: { finishedAt: '2026-10-13T10:00:00Z' } }],
  })
  const noGit = () => null
  assert.equal(await main(['releases', 'new', 'api@7'], { fetch: s.fetch, env, git: noGit, out: () => {} }), 0)
  assert.equal(s.calls[0].body.commit, undefined)
  assert.equal(await main(['releases', 'finalize', 'api@7', '--service', 'api'], { fetch: s.fetch, env, git: noGit, out: () => {} }), 0)
  assert.deepEqual([s.calls[1].body.finalize, s.calls[1].body.service], [true, 'api'])
  assert.equal(await main(['releases', 'deploy', 'api@7', '--env', 'production', '--name', 'deploy 12', '--deploy-url', 'https://ci/d/12',
    '--started', '2026-10-13T09:58:00Z'], { fetch: s.fetch, env, git: noGit, out: () => {} }), 0)
  assert.deepEqual(s.calls[2].body, { version: 'api@7', environment: 'production', name: 'deploy 12', url: 'https://ci/d/12',
    startedAt: '2026-10-13T09:58:00Z' })
})

test('errors are explained and exit non-zero: no key, a refusal from the server, an unknown command', async () => {
  const lines = []
  assert.equal(await main(['releases', 'new', 'x@1'], { env: {}, git: () => null, err: l => lines.push(l) }), 1)
  assert.match(lines[0], /ZIPLOGGER_API_KEY/)
  const refused = server({ 'POST /api/v1/releases': () => [403, { error: 'This key belongs to the "staging" environment' }] })
  assert.equal(await main(['releases', 'new', 'x@1'], { fetch: refused.fetch, env, git: () => null, err: l => lines.push(l), out: () => {} }), 1)
  assert.match(lines.at(-1), /403.*staging/)
  assert.equal(await main(['releases', 'remove', 'x@1'], { fetch: refused.fetch, env, git: () => null, err: l => lines.push(l) }), 1)
  assert.match(lines.at(-1), /Unknown command/)
  const out = []
  assert.equal(await main(['--help'], { out: l => out.push(l) }), 0)
  assert.match(out[0], /releases new/)
})

test('source maps are collected without node_modules and uploaded in batches under the request limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zl-maps-'))
  try {
    mkdirSync(join(dir, 'assets')); mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)\n//# sourceMappingURL=app.js.map')
    writeFileSync(join(dir, 'assets', 'app.js.map'), '{"version":3}')
    writeFileSync(join(dir, 'assets', 'style.css'), 'body{}')
    writeFileSync(join(dir, 'node_modules', 'dep.js.map'), '{}')
    assert.deepEqual(collectFiles((await import('node:fs')).default, [dir]).map(f => f.name), ['assets/app.js', 'assets/app.js.map'])
    assert.deepEqual(batches([{ size: 5 }, { size: 5 }, { size: 5 }], 10, 100).map(b => b.length), [2, 1])
    assert.deepEqual(batches([{ size: 50 }, { size: 1 }], 10, 100).map(b => b.length), [1, 1])
    assert.deepEqual(batches([{ size: 1 }, { size: 1 }, { size: 1 }], 100, 2).map(b => b.length), [2, 1])

    const s = server({ 'POST /api/v1/sourcemaps': () => [200, { stored: 1, replaced: 0, skipped: [], errors: [] }] })
    const lines = []
    assert.equal(await main(['sourcemaps', 'upload', dir, '--release', 'web@1', '--url-prefix', '~/static'], { fetch: s.fetch, env, out: l => lines.push(l) }), 0)
    const form = s.calls[0].body
    assert.equal(form.get('release'), 'web@1')
    assert.equal(form.get('urlPrefix'), '~/static')
    assert.deepEqual(form.getAll('files').map(f => f.name), ['assets/app.js', 'assets/app.js.map'])
    assert.match(lines[0], /1 stored, 0 replaced, from 2 files/)
    const err = []
    assert.equal(await main(['sourcemaps', 'upload', dir], { fetch: s.fetch, env, err: l => err.push(l) }), 1)
    assert.match(err[0], /--release is required/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
