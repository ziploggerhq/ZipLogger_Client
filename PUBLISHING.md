# Publishing the SDKs

What `.github/workflows/publish.yml` does per registry, and the one-time human setup each
registry needs before its job can succeed. Most of this is already done — npm, Go and PHP's
*tests* are green on every tagged release. What's listed here as "still to do" is exactly that:
verified against the live registries, not assumed.

## Tags

| Tag | Publishes |
|---|---|
| `v1.2.3` | Every registry that has its setup done: today, npm only (see below) |
| `npm-v1.2.3` | npm only — `ziplogger` (sdk_node) and `@ziplogger/browser` (sdk_browser) |
| `pypi-v1.2.3` | PyPI only — `ziplogger` |
| `maven-v1.2.3` | Maven Central only — `dev.ziplogger:ziplogger` |
| `gem-v1.2.3` | RubyGems only — `ziplogger`. **Not on `v*` yet** — see RubyGems below |
| `packagist-v1.2.3` | Nothing to upload; proves the tag installs. Packagist itself still needs the one-time submission below |
| `sdk_go/v1.2.3` | Nothing to upload; the Go module proxy reads git tags directly |

Each package's version comes from its own manifest (`package.json`, `pyproject.toml`, `pom.xml`,
`*.gemspec`), not from the tag — the tag only decides which jobs run. A job whose manifest version
is already on the registry skips itself rather than failing (npm and PyPI do this via their own
tooling; Maven does it by checking the public `repo1.maven.org` mirror first, since the plugin has
no such flag and a Central release is immutable). That is what makes `git tag v1.2.3 && git push
--tags` a safe thing to run when only one SDK actually changed.

## What's actually live today

Verified against the registries directly, not from the workflow's last green run:

| Registry | Package | Status |
|---|---|---|
| npm | `ziplogger`, `@ziplogger/browser` | **live** |
| Go proxy | `github.com/ziploggerhq/ZipLogger_Client/sdk_go` | **live** (nothing to set up; tags are the release) |
| PyPI | `ziplogger` | **live** |
| Maven Central | `dev.ziplogger:ziplogger` | **live** |
| Packagist | `ziplogger/ziplogger` | **not submitted** — `packagist.org/packages/ziplogger/ziplogger` is a 404 |
| RubyGems | `ziplogger` | **not submitted** — no Trusted Publisher configured |

## RubyGems: one-time setup

The `rubygems` job failed on a `v0.6.0` release with:

```
No trusted publisher configured for this workflow found on https://rubygems.org for audience rubygems.org
```

RubyGems uses OIDC Trusted Publishing the same way PyPI does (no `RUBYGEMS_API_KEY` secret exists
in this repo on purpose), but the trust has to be registered on rubygems.org's side first, by a
human with a rubygems.org account. RubyGems supports doing this **before the gem exists**
("pending trusted publisher"), which is the case here.

1. Sign in at [rubygems.org](https://rubygems.org) (create an account if none owns `ziplogger` yet).
2. **Profile → Trusted Publishers → Add a pending trusted publisher** (or, once the gem exists,
   the same panel from the gem's own page).
3. Fill in exactly:
   - **Gem name:** `ziplogger`
   - **Repository owner:** `ziploggerhq`
   - **Repository name:** `ZipLogger_Client`
   - **Workflow filename:** `publish.yml`
   - **Environment:** `rubygems` — must match the `environment: rubygems` in the `rubygems` job
     in `.github/workflows/publish.yml` exactly, or the OIDC audience won't match.
4. Push a `gem-v1.2.3` tag (the `rubygems` job is deliberately not on the shared `v*` tag until
   this is done — see the comment above the job). Re-add `startsWith(github.ref_name, 'v')` to its
   `if:` once this step is complete, if you want it back on the shared tag.

## Packagist: one-time setup

Packagist has no CI step that uploads anything — `sdk_php/composer.json` is read straight from
this repo, kept in sync by a webhook. The package still has to be **submitted once**:

1. Sign in at [packagist.org](https://packagist.org) with a GitHub account that can manage this
   repo (or one added as a maintainer afterwards).
2. **Submit** → the repository URL, `https://github.com/ziploggerhq/ZipLogger_Client`. Packagist
   detects `sdk_php/composer.json` needs pointing at explicitly if it does not find a
   root-level `composer.json` — check its "Update" step reads `sdk_php/` (the [Update Packages
   from a Directory](https://packagist.org/about) note in its own docs covers monorepo layouts).
3. Enable the **GitHub Service Hook** it offers (or add `https://packagist.org/api/github?username=…`
   as a repository webhook manually) so every push updates the listing without another manual step.
4. From then on, `packagist-v1.2.3` (or the shared `v*` tag, which already includes `php`) is
   enough — the job's only job is proving the tagged commit installs and passes its tests.
