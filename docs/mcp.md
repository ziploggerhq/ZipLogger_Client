# MCP server

ZipLogger is an MCP (Model Context Protocol) server, so AI coding assistants can query your
workspace directly. Ask "why is checkout failing in prod?" and the assistant searches your logs,
clusters error patterns, walks trace waterfalls, and reads regression analyses on its own, instead
of asking you to paste log lines into a chat window.

Read-only, authenticated with a workspace ingestion key.

## Connect

```bash
claude mcp add ziplogger --transport http https://app.ziplogger.ai/mcp \
  --header "X-Api-Key: zk_..."
```

Any MCP client that speaks streamable HTTP works the same way. The generic form:

```json
{
  "mcpServers": {
    "ziplogger": {
      "type": "http",
      "url": "https://app.ziplogger.ai/mcp",
      "headers": { "X-Api-Key": "zk_..." }
    }
  }
}
```

Use a **dedicated key** for MCP so you can revoke assistant access without touching ingestion.

## Tools

| Tool | Parameters | Returns |
|---|---|---|
| `search_logs` | `query`, `severity`, `hours` (default 24), `limit` (default 20, max 100) | Newest matching log events |
| `list_error_patterns` | `hours` (default 24), `query` | Recent errors clustered into message templates with counts, each with an example, stack trace, and trace id when available |
| `list_traces` | `hours` (default 24), `errorsOnly`, `service` | One row per request or job |
| `get_trace` | `traceId` (32-char hex) | The full waterfall: every span in start order, with parent links, durations, status, and attributes |
| `get_services_status` | none | Every service seen in the last 24 h with last-seen time, error count over the last 15 minutes, and health-check results where configured |
| `list_regressions` | none | Git regression cases: production errors traced back to suspect commits, with author, confidence, and the AI root-cause and fix where analyzed |

Everything is scoped to the workspace the key belongs to. There are no write tools, so an assistant
cannot delete logs, change alert rules, or touch billing.

## Query syntax

`search_logs` (and the Search page, and log-count alert rules) take the same syntax:

| Form | Example |
|---|---|
| Bare words, all must match | `payment declined` |
| Quoted phrase | `"connection reset by peer"` |
| Field filter | `severity:error`, `source:checkout-api`, `release:2026.08.22-133` |
| Custom field filter | `fields.userId:123`, `fields.orderId:83112` |
| Boolean operators | `timeout AND NOT healthcheck`, `payment OR refund` |
| Wildcards | `Sync*` |

## A worked example

The point is chaining. A useful session tends to run:

1. `get_services_status` to see which service is unhealthy.
2. `list_error_patterns` on that service to see what is actually breaking, ranked by volume, rather
   than reading individual lines.
3. `get_trace` on a trace id from the example event, to see where in the request it died.
4. `list_regressions` to check whether a commit is already implicated.

Because the assistant has your source tree open at the same time, step 4 lands in the right place:
it can read the suspect commit's diff and the failing stack frame together.

## Guidance for prompting

- Name the time window. "in the last 2 hours" beats "recently", which the model has to guess at.
- Name the service if you know it. `list_error_patterns` across a busy workspace returns a lot.
- Ask for patterns before lines. Clustering is what makes a thousand errors readable.
- Paste a trace id when you have one from the UI. `get_trace` is the highest-signal call available.

## Notes and limits

- **Read-only and tenant-scoped.** Every tool resolves the workspace from the key on each request.
- `search_logs` returns at most 100 events per call; `get_trace` at most 500 spans.
- `list_error_patterns` clusters over a bounded sample of recent errors, so it is a ranking of what
  is breaking, not an exhaustive audit.
- Error-free traces are pruned after your workspace's window (up to 30 days), so `get_trace` on an old healthy trace can come back
  empty. See [tracing](tracing.md#quotas-and-retention).
- MCP calls query your existing data. They consume no log quota, and no AI requests either: the
  reasoning happens in your assistant, on your AI account.
- This is separate from in-app AI analysis, which uses your own provider key under
  **Settings → AI analysis**.

## Troubleshooting

| Symptom | Check |
|---|---|
| `Unauthorized: send your ZipLogger API key in the X-Api-Key header` | The header is `X-Api-Key`. Some clients need it quoted exactly as `"X-Api-Key: zk_..."`. |
| Tools listed but every call is empty | The key belongs to a workspace with no data in the window. Widen `hours`. |
| Assistant does not use the tools | Mention ZipLogger explicitly in the prompt, or confirm the server is connected in your client. |
