# Publishing the SDKs

Everything in this repository is packaging-ready and CI-wired. What remains are the account steps
that need a human with the registry logins. Do them once; afterwards every release is a git tag.

Current state at 0.3.3: NuGet, npm x2, PyPI, Maven Central and the Go proxy are **live**, each
verified by installing the published package and running it. Those accounts are already set up, so
future releases there are a tag and nothing else.

The Ruby and PHP SDKs are written, tested and CI-wired, but **RubyGems and Packagist have not been
registered yet**: sections 3 and 5 below are the one-time account work that is still outstanding.
Until they are done, a `v*` tag publishes the other registries and the two new jobs fail on
authentication, so tag the per-registry names until the accounts exist.

| Registry | Package | Account work needed | Then publishing is |
|---|---|---|---|
| npm | `ziplogger`, `@ziplogger/browser` | create npm account + `ziplogger` org, add `NPM_TOKEN` secret | automatic on tag |
| PyPI | `ziplogger` | create PyPI account, add a Trusted Publisher | automatic on tag, no token stored |
| RubyGems | `ziplogger` | create RubyGems account, add a Trusted Publisher | automatic on tag, no token stored |
| Maven Central | `dev.ziplogger:ziplogger` | Central account, verify `ziplogger.ai` by DNS, GPG key, 4 secrets | automatic on tag |
| Packagist | `ziplogger/ziplogger` | create a Packagist account, submit the repo URL once, enable the GitHub hook | automatic on tag, no token stored |
| Go module proxy | `github.com/ziploggerhq/ZipLogger_Client/sdk_go` | none, the proxy reads this public repo | tag only |
| NuGet | `ZipLogger.*` | already done | tag in the platform repo |

## 1. npm (fastest, about 5 minutes)

1. Create an account at <https://www.npmjs.com/signup> and enable 2FA.
2. Create the organization `ziplogger` (<https://www.npmjs.com/org/create>, free for public
   packages). This reserves the `@ziplogger/*` scope used by the browser SDK.
3. Create an access token: **Access Tokens → Generate New Token → Granular**, with *Read and write*
   on packages and on the `ziplogger` org. Under **Security settings**, check **Bypass two-factor
   authentication (2FA)**. Without that box every publish fails with a 403 reading "Two-factor
   authentication or granular access token with bypass 2fa enabled is required", after the run has
   already built and signed the package. The box can also be ticked later by editing the token,
   which leaves the token value unchanged, so the GitHub secret does not need updating.
4. In this repository: **Settings → Secrets and variables → Actions → New repository secret**,
   name `NPM_TOKEN`, paste the token.

## 2. PyPI (about 10 minutes, no token to store)

1. Create an account at <https://pypi.org/account/register/> and enable 2FA.
2. Go to <https://pypi.org/manage/account/publishing/> and add a **pending trusted publisher**:
   - PyPI project name: `ziplogger`
   - Owner: `ziploggerhq`
   - Repository: `ZipLogger_Client`
   - Workflow: `publish.yml`
   - Environment: `pypi`
3. In this repository: **Settings → Environments → New environment** named `pypi` (no secrets
   needed; the workflow authenticates with OIDC).

Trusted Publishing is worth the extra step: there is no long-lived API token to leak.

## 3. RubyGems (about 10 minutes, no token to store)

1. Create an account at <https://rubygems.org/sign_up> and enable MFA
   (**Settings → Multi-factor authentication**, level *UI and gem signin* or stricter). The gemspec
   sets `rubygems_mfa_required`, so the account must have MFA before the first push.
2. The gem name `ziplogger` does not exist yet, so register a **pending** trusted publisher at
   <https://rubygems.org/trusted_publisher/pending/new>:
   - RubyGem name: `ziplogger`
   - Publisher: GitHub Actions
   - Repository owner: `ziploggerhq`
   - Repository name: `ZipLogger_Client`
   - Workflow filename: `publish.yml`
   - Environment: `rubygems`

   After the first release, the same settings live under the gem's own **Trusted publishers** page.
3. In this repository: **Settings → Environments → New environment** named `rubygems` (no secrets
   needed; the workflow authenticates with OIDC).

The gem is built from `sdk_ruby/`. Its Rakefile defines a `release` task that only builds and
pushes, so `rubygems/release-gem` never creates git tags of its own. That matters with two tag
schemes: Bundler's stock `release` task would push a `v0.4.0` tag, and on a `gem-v0.4.0` release
that new tag would re-trigger every other registry's job.

## 4. Maven Central (the long one, about 30 minutes)

1. Register at <https://central.sonatype.com/> (sign in with GitHub is fine).
2. Claim the namespace `dev.ziplogger`: **Namespaces → Add Namespace → dev.ziplogger**. Central
   will show a TXT record to add to the `ziplogger.ai` DNS zone (in Cloudflare: DNS → Records →
   Add record → TXT, name `@`, value as shown). Click Verify once it propagates.
3. Generate a publishing token at <https://central.sonatype.com/usertoken> and click
   **Generate User Token**. A modal shows a username and password pair. Copy both immediately: the
   modal cannot be reopened, and a lost token can only be replaced. These two values are
   `MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_PASSWORD`, not your login email and password.
4. Create a GPG key for signing (Central rejects unsigned artifacts). Run these in Git Bash, one at
   a time; each pops a pinentry window for the passphrase. The key id is the hex string after
   `rsa4096/` on the `sec` line. Note which half goes where: the **public** key goes to a keyserver
   so Central can check the signatures, the **private** key goes into the GitHub secret so CI can
   produce them.

   ```bash
   gpg --quick-generate-key "Your Name <you@example.com>" rsa4096 sign 2y
   gpg --list-secret-keys --keyid-format=long              # note the key id
   gpg --keyserver keyserver.ubuntu.com --send-keys <KEY_ID>   # public half
   cd ~ && gpg --armor --export-secret-keys <KEY_ID> > private-key.asc   # private half
   cat ~/private-key.asc | clip                           # straight to the clipboard
   ```

   Export the private key somewhere that does not sync: a OneDrive-backed Desktop would upload it.
   Delete `private-key.asc` once the secret is saved; the key stays in `~/.gnupg`.

   **Verify the keyserver upload actually landed.** `--send-keys` exits 0 even when dirmngr could
   not reach the server, and the only symptom is Central rejecting every `.asc` file with "Could not
   find a public key by the key fingerprint" after a full build. A 200 here means Central can see it:

   ```bash
   curl -s -o /dev/null -w "%{http_code}
" "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x<FULL_FINGERPRINT>"
   ```

5. Add four repository secrets: `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD` (from step 3),
   `MAVEN_GPG_KEY` (contents of `private-key.asc`), `MAVEN_GPG_PASSPHRASE`.
6. Delete `private-key.asc` afterwards.

If Maven Central feels like too much for now, skip it: the other registries are independent, and
the Java SDK can keep being consumed from source.

## 5. Packagist (about 5 minutes, no token to store)

Packagist does not host files. It indexes `composer.json` files it finds in a git repository and
serves the version list to Composer, which then downloads the tagged source from GitHub. So there
is nothing to upload and no secret to store; registration happens once and every later tag is
picked up automatically.

1. Create an account at <https://packagist.org/register/> (sign in with GitHub is fine).
2. **Submit** (<https://packagist.org/packages/submit>) the repository URL
   `https://github.com/ziploggerhq/ZipLogger_Client`. Packagist finds `sdk_php/composer.json`
   by the `name` field `ziplogger/ziplogger`. If it complains that the file is not at the root,
   submit with the path: the "Repository URL" field accepts a path suffix for monorepos, or
   configure the package's **Edit → Subdirectory** to `sdk_php` after the first submit.
3. Enable auto-update. Either install the **Packagist GitHub App** on the `ziploggerhq`
   organisation (Packagist → Profile → "Connect with GitHub"), which needs no secret and covers
   every repository, or add the classic webhook: repository **Settings → Webhooks → Add**,
   payload URL `https://packagist.org/api/github?username=<packagist-user>`, content type
   `application/json`, secret = your Packagist API token (Profile → Show API Token), events:
   *Just the push event*.
4. Push a tag. Within a minute the version appears at
   <https://packagist.org/packages/ziplogger/ziplogger> and `composer require ziplogger/ziplogger`
   resolves it.

The version is the git tag with the leading `v` stripped (`v0.4.0` → `0.4.0`), read from the tag
that points at the commit, so **`sdk_php/composer.json` must not contain a `version` field**.
Adding one would pin every tag to the same version and Packagist would reject the duplicates.
Tags with a prefix such as `packagist-v0.4.0` are ignored by Packagist, which is fine: the `v*`
tag on the same commit is the one it indexes, and `packagist-v*` exists only to re-run the CI
job on its own.

## 6. Release

Push this repository to GitHub (it must be public for the Go module proxy), then tag:

Tag either the all-in-one `v*` or the per-registry tags, never both for the same version. Both
match the Maven job, so two runs race for the same coordinate and one fails with "currently being
published in another deployment" even though the other is succeeding.

```bash
git tag v0.3.3 && git push origin v0.3.3          # everything
git tag npm-v0.3.3 && git push origin npm-v0.3.3  # npm only
git tag pypi-v0.3.3 && git push origin pypi-v0.3.3
git tag maven-v0.3.3 && git push origin maven-v0.3.3
git tag gem-v0.4.0 && git push origin gem-v0.4.0         # RubyGems only
git tag sdk_go/v0.3.3 && git push origin sdk_go/v0.3.3   # required for `go get @v0.3.3`
git tag packagist-v0.4.0 && git push origin packagist-v0.4.0   # re-run the PHP CI job only
```

The Go tag must keep the `sdk_go/` prefix: that is how Go versions a module living in a
subdirectory. Without it, `go get` can still fetch `@latest` from the default branch, but pinned
versions will not resolve.

## 7. Verify after publishing

```bash
pip download ziplogger==0.3.3 -d /tmp/zl --no-deps
npm view ziplogger version && npm view @ziplogger/browser version
GOPROXY=proxy.golang.org go list -m github.com/ziploggerhq/ZipLogger_Client/sdk_go@v0.3.3
curl -s https://repo1.maven.org/maven2/dev/ziplogger/ziplogger/0.3.3/ | head
gem fetch ziplogger -v 0.4.0 && gem specification ziplogger-0.4.0.gem version
cd $(mktemp -d) && composer require ziplogger/ziplogger:0.4.0 && php -r 'require "vendor/autoload.php"; echo ZipLogger\Client::mapLevel("critical"), PHP_EOL;'
```

## Release checklist for future versions

1. Bump the version in `sdk_python/pyproject.toml`, `sdk_node/package.json`,
   `sdk_browser/package.json`, `sdk_java/pom.xml`, `sdk_ruby/lib/ziplogger/version.rb` (Go and PHP
   take their version from the tag; keep `sdk_php/composer.json` without a `version` field).
2. Run the tests: `npm test` in both npm packages, `python -m unittest discover -s tests` in
   `sdk_python`, `go test ./...` in `sdk_go`, `mvn test` in `sdk_java`, `bundle exec rake test` in
   `sdk_ruby`, `composer install && vendor/bin/phpunit` in `sdk_php`.
3. Tag `vX.Y.Z` plus `sdk_go/vX.Y.Z` and push.
