# Session replay

Watch what a user actually did before an error: the pages they saw, where the cursor went, what
they clicked, what they typed into which field. Not a video — ZipLogger records the DOM and rebuilds
it, so a replay is a few hundred kilobytes rather than a few hundred megabytes, and the text in it
is real text.

Replays attach to the same session id your events and errors already carry, so a replay is one
click from the session journey and from any error that happened in it.

```bash
npm install @ziplogger/browser @rrweb/record
```

`@rrweb/record` is the recorder. It is an **optional peer dependency**: install it only if you
want session replay, and it is downloaded by the browser only for visitors you actually record.
Without it, `@ziplogger/browser` is the same zero-dependency 3.4 KB (gzipped) package it has
always been.

## Turning it on

```js
import { ZipLoggerBrowser } from '@ziplogger/browser'
import { attachSessionReplay } from '@ziplogger/browser/replay'

export const ziplogger = new ZipLoggerBrowser({
  endpoint: 'https://app.ziplogger.ai',
  apiKey: 'zk_...',
  sessionReplay: {
    enabled: true,
    sampleRate: 0.1,      // record 10% of sessions
  },
})

attachSessionReplay(ziplogger)   // starts recording on its own when `enabled` is true
```

Two things have to agree before a single event is recorded: your configuration above, and your
ZipLogger workspace (**Settings → Session replay**, on paid plans). The SDK asks the server first
and records nothing if the answer is no — which is also how recording can be switched off during
an incident without you deploying anything.

Control it by hand if you would rather decide per page or per user:

```js
ziplogger.sessionReplay.start()        // idempotent; obeys sampling and the server's answer
ziplogger.sessionReplay.stop()         // sends what is buffered as the final chunk
ziplogger.sessionReplay.isRecording()  // boolean
```

`stop()` then `start()` continues the same session. `ziplogger.reset()` on sign-out ends the
recording and begins a new one under a new session id.

## What is never recorded

Session replay is the feature most likely to capture something it should not, so the defaults are
strict and some of them cannot be turned off.

**Always masked, whatever your configuration says:**

- `<input type="password">`
- any element with `autocomplete` of `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`,
  `cc-exp-year`, `cc-name`, `one-time-code`, `current-password` or `new-password`
- anything inside `[data-ziplogger-mask]`

**Masked by default** (`maskInputs: true`): the value of every `<input>` and `<textarea>`. The
replay shows asterisks of the same length, so you can see that someone typed sixteen characters
into the card field and struggled with it, without ever seeing the number.

**Never captured at all:** cookies, `localStorage`, `sessionStorage`, request or response headers,
authorization tokens, and query strings — a recorded URL is stored as origin and path only, so a
password-reset link or a session token in a URL never leaves the browser.

All of this happens **in your visitor's browser, inside the serialiser**, before anything is sent.
The masked values do not exist in the uploaded data, so there is nothing on our side to delete.

### Marking up your own page

```html
<!-- Masked: recorded as asterisks -->
<input data-ziplogger-mask name="delivery-note" />
<div data-ziplogger-mask>Account balance: $4,210.55</div>

<!-- Ignored: not recorded at all. The replay shows an empty box of the same size. -->
<div data-ziplogger-ignore>
  <SupportChat />
</div>
```

Or with selectors, if the markup is not yours to change:

```js
sessionReplay: {
  enabled: true,
  maskSelector: '.customer-name, .invoice-total',   // text masked
  blockSelector: '#intercom-container',             // subtree not recorded
}
```

For an app that renders personal data as ordinary text, mask everything and keep the layout:

```js
sessionReplay: { enabled: true, maskAllText: true }
```

You then see structure, navigation and interaction — where someone clicked, what they scrolled
past, which step they abandoned — with no readable content at all. Your workspace can also force
this for every app that reports to it, from **Settings → Session replay**.

## Sampling

`sampleRate` is a share of sessions, from `0` to `1`, decided once per session and stable across
reloads — a visitor is either recorded for their whole visit or not at all, never half of it.

```js
sessionReplay: { enabled: true, sampleRate: 0.25 }   // a quarter of sessions
```

A rate set in your ZipLogger workspace overrides the one in your code, so you can turn recording
down (or off) without a deploy. Start low; 5–10% answers most questions about a bug you cannot
reproduce.

## All the options

| Option | Default | What it does |
|---|---|---|
| `enabled` | `false` | Record this app's sessions |
| `sampleRate` | `1` | Share of sessions to record, 0–1. Your workspace's rate wins if set |
| `maskInputs` | `true` | Mask every input and textarea value |
| `maskAllText` | `false` | Mask every text node on the page |
| `maskSelector` | — | Extra CSS selector whose text is masked |
| `blockSelector` | — | Extra CSS selector whose subtree is not recorded |
| `maxSessionSeconds` | `3600` | Stop recording after this long |
| `maxSessionBytes` | `50000000` | Stop once this much data has been produced |
| `flushIntervalMs` | `5000` | How long to buffer before uploading |
| `flushEvents` | `100` | Upload once this many events are buffered |
| `flushBytes` | `262144` | Upload once the buffer reaches this size |

Your workspace's limits are the ceiling: if ZipLogger says one hour, asking for two gives you one.

## What it costs your page

Measured on Chromium 141, 14 threads, with `tools/replay-bench` in the ZipLogger repository:

| | |
|---|---|
| Added to your entry bundle | **+2.8 KB gzipped** |
| Recorder, fetched only for recorded visitors | 22.7 KB gzipped |
| Extra main-thread time per DOM mutation | **0.019 ms** (+6.2% over the same work uninstrumented) |
| Long tasks (>50 ms) caused by recording | **0** |
| First snapshot, 500-node page / 5,000-node page | 22 ms / 61 ms |
| Memory while recording | ~3.5 MB |
| Upload bandwidth for a continuously busy visitor | ~157 KB/minute, ≈9 MB/hour, gzipped |

Uploads are gzipped in the browser where `CompressionStream` exists (Chrome/Edge 92+, Firefox 113+,
Safari 16.4+) and sent with `keepalive` on the final chunk, so closing the tab does not lose the
end of the session.

## Failure is contained

Session replay can never take your page down or your other telemetry with it. Every recorder
callback, buffer write and upload is wrapped: an exception anywhere stops replay for that session
only, writes one `console.debug` line, and leaves your logs, events and traces working exactly as
before. If `@rrweb/record` is missing, blocked by your CSP, or fails to load, the SDK notices and
records nothing — no error is thrown into your application.

If uploads back up (a visitor on a bad connection), recording stops for that session rather than
growing a queue in their tab.

## Watching a replay

In ZipLogger: **Replays** in the sidebar, or **▶ Watch the replay** on any session journey.

The player has play/pause, seek, ±10 s, speeds from 0.5× to 8×, and skip-idle so a two-minute pause
does not cost you two minutes. Under the timeline are markers for what else ZipLogger recorded in
that session — errors, failed requests, and the events you tracked — and clicking one jumps the
player to that moment. Long recordings are loaded in parts as you watch, so opening one does not
download the whole session.

Replays are only visible to members of your workspace. Every recording is rendered in a sandboxed
frame with scripting disabled, and scripts, event handlers and unsafe URLs are stripped from the
recorded DOM before it is played — a recording is treated as untrusted data, not as a page.

## Retention and deletion

Recordings are kept for **30 days** by default, and your workspace can set anything from 1 day up
to its plan's maximum (**Settings → Session replay**). Replay retention is separate from log, trace
and event retention: a recording is much larger than a log line, and most teams want it for a
shorter window.

Shortening the window applies on the next cleanup, without your having to touch anything.
Workspace admins can also delete a single recording from the player, which removes its data
immediately.

## What is not captured

| | |
|---|---|
| Cross-origin iframes | Not recorded — a browser boundary. The frame appears as an empty box |
| Canvas / WebGL | Not recorded |
| `<video>` / `<audio>` content | The element and its play state, yes. The media itself, no |
| Images and fonts | Recorded by URL and loaded from your origin when the replay is watched — so an expired or authenticated URL shows as broken |
| Stylesheets your browser blocks by CORS | Their rules cannot be read, so the replay renders without them |
| IE 11 | Not supported |

## Troubleshooting

**Nothing appears in Replays.**
Check in this order:

```js
ziplogger.sessionReplay.isRecording()   // false? read the next line
ziplogger.sessionReplay.lastReason      // why it is not recording
ziplogger.sessionReplay.serverConfig    // what your workspace answered
```

`lastReason` values: `not_sampled` (this visitor was not in the sample — expected), `disabled` /
`replay_not_in_plan` / `replay_disabled_for_workspace` / `replay_disabled_globally` (your
workspace or plan says no), `unreachable` (the config request failed — check `endpoint`, the API
key, and that your CSP allows `connect-src` to it), `no_session` (no session id, which means
storage is blocked in that browser), `error` (something failed; the console has one line).

**Recording starts and stops immediately.**
`sequence_conflict` in `lastReason` means two tabs are recording under one session id, which
happens when a tab is duplicated (the copy inherits `sessionStorage`). The second tab stops; the
first keeps recording. `server_limit` means the session hit a size or length limit; the replay
plays up to that point and the viewer says so.

**A replay looks unstyled.**
Your stylesheet is served from another origin without CORS headers, so the browser will not let
the recorder read its rules. Add `Access-Control-Allow-Origin` to the stylesheet's response, or
serve it from your own origin.

**Everything is asterisks.**
That is `maskInputs` (default) or `maskAllText`, in your code or in your workspace settings. The
stricter of the two wins, on purpose.

**Content Security Policy.** Recording needs `connect-src` to your ZipLogger endpoint, and the
recorder is loaded as a script from wherever your bundler puts it (your own origin, normally). If
you use `script-src 'self'` and a CDN, make sure your chunk host is allowed.
