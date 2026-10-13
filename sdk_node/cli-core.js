'use strict'

/**
 * The `ziplogger` command line (docs: https://ziplogger.ai/docs.html#releases): releases, deploys and source maps from
 * CI. Everything that touches the outside world (fetch, git, the file system, output) is passed in, so the tests drive
 * it without a network or a repository.
 */

const nodePath = require('node:path')
const nodeFs = require('node:fs')
const { execFileSync } = require('node:child_process')

const VERSION = require('./package.json').version
const DEFAULT_URL = 'https://app.ziplogger.ai'
/** Under the 20 MB request limit in front of app.ziplogger.ai, with room for the multipart framing. */
const MAX_BATCH_BYTES = 18 * 1024 * 1024
const MAX_BATCH_FILES = 200
const MAX_COMMITS = 1000

const HELP = `ziplogger ${VERSION} — releases, deploys and source maps from CI

Usage:
  ziplogger releases new <version> [--service <name>] [--commit <sha>] [--previous-commit <sha>]
                                   [--no-commits] [--ref <ref>] [--url <link>] [--finalize]
  ziplogger releases finalize <version> [--service <name>]
  ziplogger releases deploy <version> [--service <name>] [--env <environment>] [--name <name>]
                                      [--deploy-url <link>] [--started <iso time>] [--finished <iso time>]
  ziplogger releases propose-version
  ziplogger sourcemaps upload <dir|file>... --release <version> [--dist <dist>] [--url-prefix <~/path>]

Options:
  --api-key <key>   A key with the "releases" scope (CI: releases and source maps). Default: $ZIPLOGGER_API_KEY
  --server <url>    Default: $ZIPLOGGER_URL or ${DEFAULT_URL}
  -h, --help        This help.     -v, --version   The CLI version.

"releases new" reads the commit from the checkout (git rev-parse HEAD) and the commits since the previous
release (git log), so the release page lists them. In a shallow clone (actions/checkout fetches one commit
by default) it sends only the commit, and ZipLogger reads the range from the repository connected under
Settings → Repositories; use fetch-depth: 0 to send them from CI instead.`

class CliError extends Error {}

/** --flag value / --flag=value / --switch; everything else is positional. */
function parseArgs(argv) {
  const switches = new Set(['finalize', 'no-commits', 'help', 'version'])
  const short = { h: 'help', v: 'version' }
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    const m = /^--?([A-Za-z][\w-]*)(?:=(.*))?$/.exec(a)
    if (!m) { positional.push(a); continue }
    const name = short[m[1]] ?? m[1]
    if (switches.has(name)) { flags[name] = true; continue }
    const value = m[2] ?? argv[++i]
    if (value === undefined) throw new CliError(`--${name} needs a value.`)
    flags[name] = value
  }
  return { flags, positional }
}

/** git, or null when there is no git or no repository here. */
function defaultGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }).trim()
  } catch {
    return null
  }
}

function createClient({ fetch, server, apiKey }) {
  const base = String(server).replace(/\/+$/, '')
  async function call(method, path, body, form) {
    const headers = { 'X-Api-Key': apiKey, 'User-Agent': `ziplogger-cli/${VERSION}` }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let res
    try {
      res = await fetch(base + path, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) })
    } catch (e) {
      throw new CliError(`Could not reach ${base}: ${e.message}`)
    }
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, json, text }
  }
  return {
    async json(method, path, body) {
      const r = await call(method, path, body)
      if (!r.ok) throw new CliError(`${method} ${path} failed (${r.status}): ${r.json?.error ?? r.text.slice(0, 300)}`)
      return r.json
    },
    call,
    async upload(path, form) {
      const r = await call('POST', path, undefined, form)
      if (!r.ok) throw new CliError(`Upload failed (${r.status}): ${r.json?.error ?? r.text.slice(0, 300)}`)
      return r.json
    },
  }
}

/** Commits from base (exclusive) to head, newest first; the latest 20 when there is no base. Null when git cannot say. */
function localCommits(git, cwd, base, head) {
  const format = '--format=%H%x1f%an%x1f%aI%x1f%s%x1e'
  const out = base
    ? git(['log', format, `-n${MAX_COMMITS}`, `${base}..${head}`], cwd)
    : git(['log', format, '-n20', head], cwd)
  if (out === null) return null
  return out.split('\x1e').map(s => s.trim()).filter(Boolean).map(line => {
    const [sha, author, timestamp, message] = line.split('\x1f')
    return { sha, author, timestamp, message }
  })
}

async function releasesNew(ctx, version, flags) {
  const { git, cwd, out, client } = ctx
  const service = flags.service
  let commit = flags.commit ?? git(['rev-parse', 'HEAD'], cwd)
  if (commit !== null && commit !== undefined && !/^[0-9a-f]{7,64}$/i.test(commit)) throw new CliError(`--commit must be a commit SHA, got "${commit}".`)
  const body = { version, service, ref: flags.ref, url: flags.url, commit: commit ?? undefined, finalize: flags.finalize || undefined }

  if (commit && !flags['no-commits']) {
    let base = flags['previous-commit']
    if (!base) {
      const q = new URLSearchParams({ excluding: version })
      if (service) q.set('service', service)
      const latest = await client.call('GET', `/api/v1/releases/latest?${q}`)
      if (latest.ok) base = latest.json?.commitSha ?? undefined
      else if (latest.status !== 404) throw new CliError(`Reading the previous release failed (${latest.status}): ${latest.json?.error ?? latest.text.slice(0, 200)}`)
    }
    if (base && base.toLowerCase() === commit.toLowerCase()) base = undefined
    const known = !base || git(['cat-file', '-e', `${base}^{commit}`], cwd) !== null
    if (known) {
      const commits = localCommits(git, cwd, base, commit)
      if (commits) { body.commits = commits; body.previousCommit = base }
    } else {
      body.previousCommit = base
      out(`The previous release's commit ${base.slice(0, 8)} is not in this checkout (shallow clone?); ZipLogger will read the range from the connected repository.`)
    }
  }

  const release = await client.json('POST', '/api/v1/releases', body)
  const commits = release.commitsStatus === 'client' || release.commitsStatus === 'fetched'
    ? `${release.commitCount} commit${release.commitCount === 1 ? '' : 's'}${release.commitsStatus === 'fetched' ? ' (from the repository)' : ''}`
    : release.commitsStatus ? `commits: ${release.commitsError ?? release.commitsStatus}` : 'no commit range'
  out(`Release ${release.version}${release.service ? ` of ${release.service}` : ''} in ${release.environment}: ${commits}${release.dateReleased ? ', finalized' : ''}.`)
  return release
}

async function releasesDeploy(ctx, version, flags) {
  const body = {
    version, service: flags.service, environment: flags.env, name: flags.name, url: flags['deploy-url'] ?? flags.url,
    startedAt: flags.started, finishedAt: flags.finished,
  }
  const { release, deploy } = await ctx.client.json('POST', '/api/v1/releases/deploys', body)
  ctx.out(`Deploy of ${release.version} to ${release.environment} recorded (${deploy.finishedAt}).`)
  return deploy
}

/** Every .js and .map under the given paths, skipping node_modules and dot-directories. */
function collectFiles(fs, paths) {
  const files = []
  const walk = (p, rel) => {
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) {
        if (name === 'node_modules' || name.startsWith('.')) continue
        walk(nodePath.join(p, name), rel ? `${rel}/${name}` : name)
      }
    } else if (/\.(js|mjs|cjs|map)$/i.test(p)) {
      files.push({ path: p, name: rel || nodePath.basename(p), size: st.size })
    }
  }
  for (const p of paths) {
    const st = fs.statSync(p)
    walk(p, st.isDirectory() ? '' : nodePath.basename(p))
  }
  return files
}

/** Batches under the request size and file-count limits; a single file over the size limit travels alone. */
function batches(files, maxBytes = MAX_BATCH_BYTES, maxFiles = MAX_BATCH_FILES) {
  const result = []
  let current = [], size = 0
  for (const f of files) {
    if (current.length && (size + f.size > maxBytes || current.length >= maxFiles)) { result.push(current); current = []; size = 0 }
    current.push(f); size += f.size
  }
  if (current.length) result.push(current)
  return result
}

async function sourcemapsUpload(ctx, paths, flags) {
  if (!flags.release) throw new CliError('--release is required: the release your SDKs send.')
  if (!paths.length) throw new CliError('Name the build directory, e.g. ziplogger sourcemaps upload ./dist --release "$VERSION".')
  const files = collectFiles(ctx.fs, paths)
  if (!files.some(f => /\.map$/i.test(f.name))) throw new CliError(`No .map files under ${paths.join(', ')}. Build with source maps on.`)
  let stored = 0, replaced = 0
  const skipped = [], errors = []
  for (const batch of batches(files)) {
    const form = new FormData()
    form.set('release', flags.release)
    if (flags.dist) form.set('dist', flags.dist)
    if (flags['url-prefix']) form.set('urlPrefix', flags['url-prefix'])
    for (const f of batch) form.append('files', new Blob([ctx.fs.readFileSync(f.path)]), f.name)
    const r = await ctx.client.upload('/api/v1/sourcemaps', form)
    stored += r.stored ?? 0; replaced += r.replaced ?? 0
    skipped.push(...(r.skipped ?? [])); errors.push(...(r.errors ?? []))
  }
  ctx.out(`Uploaded source maps for ${flags.release}: ${stored} stored, ${replaced} replaced, from ${files.length} files.`)
  for (const s of skipped.slice(0, 20)) ctx.out(`  skipped: ${s}`)
  for (const e of errors.slice(0, 20)) ctx.out(`  error: ${e}`)
  return { stored, replaced, skipped, errors }
}

/**
 * Runs one command. Returns the exit code; never calls process.exit, so it can be tested.
 * deps: { fetch, git(args, cwd), fs, env, cwd, out(line), err(line) }
 */
async function main(argv, deps = {}) {
  const out = deps.out ?? (line => process.stdout.write(`${line}\n`))
  const err = deps.err ?? (line => process.stderr.write(`${line}\n`))
  try {
    const { flags, positional } = parseArgs(argv)
    if (flags.version) { out(VERSION); return 0 }
    const [group, command, ...rest] = positional
    if (flags.help || !group) { out(HELP); return group || flags.help ? 0 : 1 }
    const env = deps.env ?? process.env
    const git = deps.git ?? defaultGit
    const cwd = deps.cwd ?? process.cwd()
    if (group === 'releases' && command === 'propose-version') {
      const sha = git(['rev-parse', 'HEAD'], cwd)
      if (!sha) throw new CliError('Not in a git checkout.')
      out(sha)
      return 0
    }
    const apiKey = flags['api-key'] ?? env.ZIPLOGGER_API_KEY
    if (!apiKey) throw new CliError('Set ZIPLOGGER_API_KEY (or --api-key) to a key with the "releases" scope: Settings → API keys → CI.')
    const ctx = {
      out, git, cwd, fs: deps.fs ?? nodeFs,
      client: createClient({ fetch: deps.fetch ?? globalThis.fetch, server: flags.server ?? env.ZIPLOGGER_URL ?? DEFAULT_URL, apiKey }),
    }
    if (group === 'releases') {
      const version = rest[0]
      if (!version) throw new CliError(`ziplogger releases ${command ?? '<command>'} needs the release version.`)
      if (command === 'new') { await releasesNew(ctx, version, flags); return 0 }
      if (command === 'finalize') {
        const r = await ctx.client.json('POST', '/api/v1/releases', { version, service: flags.service, finalize: true })
        out(`Release ${r.version} finalized.`)
        return 0
      }
      if (command === 'deploy' || command === 'deploys') { await releasesDeploy(ctx, version, flags); return 0 }
    }
    if (group === 'sourcemaps' && command === 'upload') { await sourcemapsUpload(ctx, rest, flags); return 0 }
    throw new CliError(`Unknown command "${positional.join(' ')}". Run ziplogger --help.`)
  } catch (e) {
    if (e instanceof CliError) { err(`error: ${e.message}`); return 1 }
    err(`error: ${e?.stack ?? e}`)
    return 2
  }
}

module.exports = { main, parseArgs, batches, collectFiles, localCommits, CliError, VERSION }
