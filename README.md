# claude-local-telemetry

Local observability for [Claude Code](https://code.claude.com/docs). An OTLP
sink, a transcript backfill, and an MCP server over one SQLite file — so you can
ask what your sessions cost, what tools ran, and whether your hooks are actually
firing, without sending telemetry anywhere.

No collector. No protobuf. No Docker. No dependencies and no build step —
TypeScript on Node 24, which ships `node:sqlite` and runs `.ts` files directly.

Requires **Node 24+** (for `node:sqlite` and TypeScript type-stripping).

## Install

As a Claude Code plugin:

```
/plugin marketplace add christopherdavenport/christopherdavenport-marketplace
/plugin install claude-local-telemetry@christopherdavenport
```

Or clone it. Node 24 is the only requirement; there is nothing to install and
nothing to build.

## Start with history you already have

Every Claude Code session has been writing a transcript to
`~/.claude/projects/`. Import them and the store is useful immediately:

```sh
npx claude-local-telemetry backfill
npx claude-local-telemetry stats
```

Or from a clone, with no install at all — Node 24 runs the TypeScript directly:

```sh
node src/cli.ts backfill
node src/cli.ts stats
```

On the machine this was built for that was 608 transcripts, 23,000 API requests
and 28,000 tool calls, in under three seconds. Re-running is safe: every insert
deduplicates on a natural key.

## Collect live sessions

```sh
node src/cli.ts sink &
```

Then point Claude Code at it, ideally via `env` in `~/.claude/settings.json`:

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1   # traces; beta, off by default
export OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json   # no default — must be set
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

`http/json` is the load-bearing setting. It makes the payloads plain JSON, which
is why the receiver is `node:http` and nothing else instead of a collector
deployment. With `grpc` or `http/protobuf` this would need one.

## Look at it

A dashboard, for the questions telemetry answers better as a picture than as
prose: cost over time, cache-ratio trend, and a session drilldown you scan
rather than query.

```sh
npm --prefix ui install     # once
npm run ui:build            # emits ui/dist
node src/cli.ts api --ui ui/dist
```

Then open <http://127.0.0.1:4319>. For development, run the API and Vite side by
side — the dev server proxies `/api` to port 4319, so the request path is the
same in both modes:

```sh
node src/cli.ts api &
npm run ui:dev
```

Eight views — overview, cost, sessions, traces, tool audit, plugins, hook health,
and a query builder — over the same ten HTTP routes. The builder is the
interesting one: pick a table, a calculation and a breakdown, then click a bar
to drill into a session and its trace. The whole query lives in the URL, so a
result is a link you can paste into an issue. It also has a raw `SELECT` box,
behind the same read-only guard the MCP server uses.

## The observability tree

`/traces` lists traces; opening one renders nested spans **with the session's
events woven in** — spans as bars with a duration, events as instants at the
point they fired.

Events carry no parent pointer, so they are placed by time containment: each
lands in the *narrowest* span covering it, which is the deepest one. Anything
covered by no span stays at the top level rather than being dropped.

The useful consequence is that a session with **no spans at all** still renders
a tree, from its events alone. That is the normal case — spans need
`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` and no backfilled transcript has ever
contained one — so the trace surface is worth something before you turn the beta
exporter on, and says which case you are looking at.

It is **Lit + the [Jack Henry Design System](https://jackhenry.design/v2)**
(`@jack-henry/jh-ui`, public npm, Apache-2.0), routed with `@lit-labs/router`
and built by Vite. The design system ships no table or chart component, so
those are built here from `jh-core` tokens; the four-series palette is checked
for colour-blind separation and contrast in both light and dark rather than
picked by eye. Theme follows the OS setting.

Nothing on the page talks to anything but this API — no fonts, no CDN, no
analytics. The store holds prompts and tool inputs.

## Ask it things

The MCP server exposes ten read-only tools — `telemetry_overview`,
`telemetry_cost`, `telemetry_sessions`, `telemetry_tool_audit`,
`telemetry_traces`, `telemetry_trace`, `telemetry_plugin_costs`,
`telemetry_hook_health`, `telemetry_run_query`, and `telemetry_sql`.

Start with `telemetry_overview`; it reports what is in the store and over what
period, which determines whether a question is answerable at all.

Every tool has an HTTP route of the same name, and both call the same function
in `queries.ts`. That parity is deliberate: when the dashboard could not run raw
SQL but Claude could, there were questions answerable in one interface and not
the other, which is exactly the drift a shared query module exists to prevent.

## Two sources, because neither is enough

|  | OTel (`sink`) | Transcripts (`backfill`) |
|---|---|---|
| `cost_usd` | **yes** | no — not recorded |
| Token counts | yes | yes, exact |
| Plugin / skill names | **redacted** to `third-party` | real names |
| Permission decisions, hook outcomes | yes | no |
| cwd, git branch | no | yes |
| History | from when you start it | months, already on disk |

Rows for the same request merge rather than duplicating. Two things follow that
change how you read any answer:

**Dollar figures only cover the period the sink was running.** Transcripts carry
exact tokens but no cost. `telemetry_overview` breaks rows down by source so the
gap is visible; don't quote a total without saying which window it covers.

**OTel redacts your own plugins.** `plugin.name`, `skill.name` and
`marketplace.name` arrive as the literal string `third-party` for anything
outside the official marketplace. `plugin_id_hash` is stable and distinct per
plugin, so `plugin_alias` maps hash back to name. Until it is populated,
per-plugin spend is blinded and `telemetry_plugin_costs` says so rather than
reporting a confident zero.

## Hook health

`telemetry_hook_health` deserves singling out. A hook that exits non-zero with
anything other than `2` is a *non-blocking error*: the guarded tool call
proceeds. So a hook can fail on every invocation with no visible symptom.

This is not hypothetical. It is how two of the three hooks in a companion safety
plugin were found to have never executed across two releases — `num_errors` was
non-zero from the first session this store ever recorded.

## Storage

SQLite, deliberately. Measured on a real corpus: ~900 API requests/day, which is
1.7M rows at five years. The heaviest group-by over 1.7M rows runs in 128ms with
three covering indexes; the whole query surface over a month of data is 82ms.

ClickHouse is built for three orders of magnitude more than this and would
reintroduce the daemon, port and config that `http/json` let us avoid. If
team-wide aggregation ever happens, revisit it — both collectors write through
`store.ts` rather than inlining SQL, so a backend change is a re-import.

## Tests

```sh
npm test          # 16 assertions, deterministic, free
npm run typecheck # tsc --noEmit; strict, with exactOptionalPropertyTypes
```

No model, no network, no dependency on your real `~/.claude/projects`. Synthetic
fixtures cover the edge cases worth pinning: an all-zero usage record, a tool
call with no result, a repeated `requestId`, a nested OTLP attribute, and a hook
run that errors.

CI runs Linux and macOS both. The first bug it ever caught was a BSD-only
`mktemp` spelling that GNU rejects — green on one, silently broken on the other.

## Cautions

- **The store holds prompts and tool inputs.** OTel includes them when the
  content flags are on; transcripts include them regardless. The file is
  unencrypted. Treat it as sensitive.
- **The sink binds to loopback and does no authentication.** Don't expose it.
- Database lives at `~/.claude/telemetry/telemetry.db`, overridable with
  `CLAUDE_TELEMETRY_DB`.

## Releasing

Published to npm on a `v*` tag via GitHub OIDC trusted publishing — no
`NPM_TOKEN`, with provenance attestation generated automatically. See
[RELEASING.md](RELEASING.md), including the one-time bootstrap: the trusted
publisher can only be configured for a package that already exists, so `0.1.0`
has to go out manually first.

## Licence

[MIT](LICENSE)
