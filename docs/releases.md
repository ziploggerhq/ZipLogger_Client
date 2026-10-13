# Releases and deploys

A release in ZipLogger is the version your SDKs send as `release`. It is created the first time telemetry carries it,
or from CI with the `ziplogger` CLI (npm package `ziplogger` 0.6.0 and later), which also records its commits and
deploys. Its page under Issues → Releases compares it with the previous release: new and regressed issues, crash-free
sessions, sessions with errors and Web Vitals.

## Key

Settings → API keys → **CI: releases and source maps**, in the environment you deploy to. A key records releases and
deploys only in its own environment. Keys made earlier with **Upload source maps** keep working.

## Commands

```bash
export ZIPLOGGER_API_KEY=zk_...                    # or --api-key
export ZIPLOGGER_URL=https://app.ziplogger.ai      # or --server; the default

npx ziplogger releases new <version> [--service web] [--commit <sha>] [--previous-commit <sha>] [--no-commits]
                                     [--ref v1.4.0] [--url <CI run link>] [--finalize]
npx ziplogger releases finalize <version> [--service web]
npx ziplogger releases deploy <version> [--service web] [--env production] [--name "deploy #42"]
                                        [--deploy-url <link>] [--started <ISO time>] [--finished <ISO time>]
npx ziplogger releases propose-version          # prints the HEAD commit
npx ziplogger sourcemaps upload <dir|file>... --release <version> [--dist <dist>] [--url-prefix "~/assets/"]
```

- **Commits.** `releases new` reads the commit from the checkout and asks ZipLogger for the previous release's commit,
  then sends `git log previous..HEAD` (newest first). A first release sends the latest 20 commits. When the previous
  commit is not in the checkout (a shallow clone), it sends only the commit and ZipLogger reads the range from the
  repository connected under Settings → Repositories (GitHub or GitLab).
- **Source maps** are collected from the directories you name (`.js` and `.map`, without `node_modules`) and uploaded
  in batches of at most 18 MB and 200 files.
- **Exit codes:** 0 on success, 1 when the request was refused (the message says why), 2 on an unexpected failure.

## GitHub Actions

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }          # so the CLI can read the commits itself
- run: npm ci && npm run build
- run: |
    npx ziplogger@latest releases new "$VERSION" --service web --url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
    npx ziplogger@latest sourcemaps upload ./dist --release "$VERSION"
    npx ziplogger@latest releases finalize "$VERSION" --service web
  env:
    ZIPLOGGER_API_KEY: ${{ secrets.ZIPLOGGER_CI_KEY }}
    VERSION: web@${{ github.sha }}
# ... deploy ...
- run: npx ziplogger@latest releases deploy "web@${{ github.sha }}" --service web
  env: { ZIPLOGGER_API_KEY: "${{ secrets.ZIPLOGGER_CI_KEY }}" }
```

## HTTP API

The CLI calls `POST /api/v1/releases`, `POST /api/v1/releases/deploys` and `GET /api/v1/releases/latest` with the key in
`X-Api-Key`; any CI can call them directly. See the API reference in the app (`/api-reference`, area "Releases").
