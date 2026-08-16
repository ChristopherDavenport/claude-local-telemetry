---
name: claude-local-telemetry
description: >
  Query, collect and audit local Claude Code telemetry — session cost, tool-call
  audit trail, token attribution by model, repo, skill or plugin. Use when asked
  what Claude Code is costing, for an audit trail of tool calls, to attribute
  spend, to set up a local OTLP sink, or why a session was slow or expensive.
  Not for hosted backends, the analytics dashboard, or telemetry from code you
  are writing.
---

# Claude Code telemetry, locally

Telemetry that never leaves the machine. Two collectors write into one SQLite
store and an MCP server queries it:

| Piece | What it does |
|---|---|
| `sink` | OTLP/HTTP-JSON receiver. Live metrics, events, spans. **The only source of `cost_usd`.** |
| `backfill` | Imports `~/.claude/projects/**/*.jsonl`. Months of history, exact tokens, **no cost**. |
| `mcp` | The `telemetry_*` tools. Read-only. |
| `api` | Same queries over HTTP, for the dashboard. |

## Use the MCP tools

`telemetry_overview` first — it reports what is actually in the store and over
what period, which determines whether a question is answerable at all.

Then `telemetry_cost` (grouped by model, day, plugin, session, cwd, branch…),
`telemetry_sessions`, `telemetry_tool_audit`, `telemetry_trace`,
`telemetry_plugin_costs`, `telemetry_hook_health`, `telemetry_run_query` for
arbitrary group-bys, and `telemetry_sql` as a read-only escape hatch.

**Run `telemetry_hook_health` whenever hooks are in question.** A hook that
exits non-zero with anything but `2` is a non-blocking error: the guarded tool
call proceeds and the session looks entirely normal. There is no other way to
notice. This is how two of three guardrails hooks were found to have never
executed across two merged releases — `num_errors` was non-zero from the first
session ever recorded.

## Two facts that change every answer

**Transcript rows have no cost.** Transcripts record exact token counts but not
`cost_usd`; that is computed server-side and only OTel reports it. So dollar
totals cover the period since the sink was running, while token totals cover
everything. `telemetry_overview` breaks rows down by source — check it before
quoting a dollar figure, and say which period it covers.

**OTel redacts your own plugins.** `plugin.name`, `skill.name` and
`marketplace.name` come through as the literal string `third-party` for
everything outside the official marketplace. `plugin_id_hash` is stable and
distinct per plugin, so `plugin_alias` maps hash back to name; until it is
populated, per-plugin spend is blinded and `telemetry_plugin_costs` says so
rather than reporting a confident zero. Transcript-derived skill and agent
invocations are **not** redacted and are the reliable signal for which of your
own plugins actually fire.

## Setting it up

Backfill is immediate and needs nothing running:

```sh
node ${CLAUDE_PLUGIN_ROOT}/src/cli.ts backfill
node ${CLAUDE_PLUGIN_ROOT}/src/cli.ts stats
```

For live collection, start the sink *before* enabling the exporters — Claude
Code drops an export it cannot deliver, silently:

```sh
node ${CLAUDE_PLUGIN_ROOT}/src/cli.ts sink &

export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1   # traces; beta, off by default
export OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json   # no default — must be set
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_LOG_TOOL_DETAILS=1                 # else tool/skill/MCP names redact
```

Put these in `~/.claude/settings.json` under `env` rather than a shell profile;
it is read at startup, so a running session will not pick it up. `http/json` is
what makes the sink dependency-free — with `grpc` or `http/protobuf` it would
need a collector. Requires Node 24 for `node:sqlite`.

`OTEL_LOG_TOOL_DETAILS` is not optional for the audit surface. Content
attributes are off by default, and without it tool names, MCP server and tool
names, skill and workflow names, tool input and file paths all arrive as
`<REDACTED>` — so `telemetry_tool_audit` returns rows you cannot read.
`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` and
`OTEL_LOG_TOOL_CONTENT` add prompt, response and payload text on top; they are
fidelity, and each puts more of the session into an unencrypted file.

This is a different redaction from the `third-party` plugin blinding, which no
flag fixes — `alias derive` is what resolves that, and only once the sink has
collected enough for the two sources to overlap.

`sink &` dies with its terminal, and `cost_usd` exists only for the period the
sink was running. For continuous collection run it as a user service (launchd
or systemd) pointed at a global `npm i -g claude-local-telemetry` install, with
an absolute path to the Node binary — service managers start with a minimal
`PATH`, and the plugin directory is a managed cache that moves on update. The
README has the details.

The database lives at `~/.claude/telemetry/telemetry.db`, overridable with
`CLAUDE_TELEMETRY_DB`.

## Cautions

- **The store contains prompts and tool inputs** when the OTel content flags are
  on (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, …), and transcripts
  contain them regardless. Treat the file as sensitive; it is chmod-nothing and
  unencrypted.
- **The sink binds to loopback and does no authentication.** Do not expose it.
- **Backfill is safe to re-run** — every insert is deduplicated on a natural key
  and merges rather than duplicates. Verified idempotent against a frozen corpus.
- Don't quote a cost number without saying which period the OTel data covers.
