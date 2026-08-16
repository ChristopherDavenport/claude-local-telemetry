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

Start the sink first. Claude Code drops an export it cannot deliver, so
enabling telemetry against a dead endpoint collects nothing and reports no
error:

```sh
node src/cli.ts sink &
```

Then point Claude Code at it. `env` in `~/.claude/settings.json` is the durable
place — the values apply to every session without touching a shell profile:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318",
    "OTEL_LOG_TOOL_DETAILS": "1"
  }
}
```

`env` is read at startup, so a session already running will not pick this up.

### The content flags are not optional here

`OTEL_LOG_TOOL_DETAILS` is in the block above deliberately. Every OTel content
attribute is **off by default**, and with them off the fields this tool exists
to show arrive as `<REDACTED>`:

| Flag | Unlocks | Exposes |
|---|---|---|
| `OTEL_LOG_TOOL_DETAILS=1` | Tool names, MCP server and tool names, skill and workflow names, tool input, file paths. **`telemetry_tool_audit` is mostly redacted without it.** | Bash command lines and file paths |
| `OTEL_LOG_USER_PROMPTS=1` | Prompt text on `user_prompt` events | What you typed |
| `OTEL_LOG_ASSISTANT_RESPONSES=1` | Assistant response text | What came back |
| `OTEL_LOG_TOOL_CONTENT=1` | Tool input and output bodies in span events. Needs tracing on. | Full tool payloads |

Only the first is needed for the audit and cost surfaces to read properly. The
rest are fidelity, and each one puts more of your session into an unencrypted
file — see [Cautions](#cautions). Note this is a *different* redaction from the
`third-party` plugin blinding, which no flag fixes; that one is what
[`alias derive`](#un-blinding-plugin-cost) is for.

### Keeping the sink up

`sink &` dies with the terminal, and `cost_usd` only exists for the period the
sink was running — so uptime is the whole game. Run it as a user service.

On macOS, a LaunchAgent in `~/Library/LaunchAgents` with `RunAtLoad` and
`KeepAlive` set. On Linux, a systemd user unit with `Restart=always` and
`systemctl --user enable --now`.

Two things make the difference between a service that works and one that fails
silently:

- **Give the absolute path to the Node binary, not the bare command.** launchd
  and systemd start with a minimal `PATH`, so a Node installed by nvm, fnm, asdf
  or volta will not resolve, and the shebang's `/usr/bin/env node` will not
  either. `command -v node` gives you the path to hard-code.
- **Point the service at a global install, not at the plugin directory.**
  Claude Code keeps plugins in a versioned, managed cache, so that path moves
  on the next plugin update and leaves the unit pointing at nothing:

  ```sh
  npm i -g claude-local-telemetry     # stable path: command -v claude-local-telemetry
  ```

  This is what the npm package is *for*. Install the plugin from the
  marketplace to get the skill and the MCP server; install the package globally
  to get a binary a service manager can rely on. They are separate channels on
  purpose.

### Checking it works

`telemetry_overview` reports a `bySource` breakdown, and that is the tell:

```
"bySource": { "otel": 2, "transcript": 28268 }
```

An `otel` count above zero means the sink is receiving. Metrics flush on an
interval rather than per request, so give it a minute before concluding
anything — or set `OTEL_METRIC_EXPORT_INTERVAL=10000` while you are debugging
and drop it again afterwards.

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

Nine views — overview, cost, sessions, agents, traces, tool audit, plugins, hook
health, and a query builder — over the same fourteen HTTP routes. The builder is the
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

## Delegated work

Subagents write their own transcripts, under
`<project>/<session>/subagents/[workflows/<runId>/]agent-<id>.jsonl`. Backfill
has always read them; since schema v2 it also reads the *path*, which is the
only place the linkage exists.

Where agents are used heavily that can be a large share of all token spend,
previously belonging to nobody in particular.

Two things follow that are worth stating plainly:

**An agent is not a session.** Agent transcripts carry their *parent's* session
id, so their turns were already landing in the parent's totals — just
unlabelled. `agent_id` therefore hangs off `api_requests` and
`tool_calls`, and a session page shows what it delegated rather than pretending
the agents were separate sessions.

**Measured, not reported.** A synchronous agent returns its token totals to the
caller; a backgrounded one acknowledges and never does. So the figures here are
summed from each agent's own transcript, with the reported total shown beside
them when it exists.

## Un-blinding plugin cost

```sh
claude-local-telemetry alias derive
```

OTel knows a plugin's `plugin_id_hash` but calls it `third-party`; the
transcript names it outright. Both key on `request_id`, so where the two sources
describe the same request the mapping can be *read off* rather than guessed. A
hash that maps to two names is reported as ambiguous rather than resolved by
majority — settle those with `alias set <hash> <name>`, which outranks a derived
mapping and survives re-derivation.

Run this *after* the sink has collected for a while, not the moment you enable
it. The mapping is read off the overlap between the two sources, so with little
OTel data there is nothing to join and it correctly reports:

```
learned 0 mapping(s); 0/0 hashes now named
no plugin_id_hash in the store: that only arrives from the OTLP sink.
```

That is the expected output on a fresh sink, not a failure. It is idempotent —
re-run it whenever you want to pick up newly seen plugins.

## Ask it things

The MCP server exposes fourteen read-only tools — `telemetry_overview`,
`telemetry_cost`, `telemetry_sessions`, `telemetry_tool_audit`,
`telemetry_traces`, `telemetry_trace`, `telemetry_workflows`,
`telemetry_workflow`, `telemetry_agents`, `telemetry_teams`,
`telemetry_plugin_costs`, `telemetry_hook_health`, `telemetry_run_query`, and
`telemetry_sql`.

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

SQLite, deliberately. Sized against heavy daily use — on the order of a
thousand API requests a day, so a few million rows after five years. The
heaviest group-by over 1.7M rows runs in 128ms with three covering indexes; the
whole query surface over a month of data is 82ms.

ClickHouse is built for three orders of magnitude more than this and would
reintroduce the daemon, port and config that `http/json` let us avoid. If
team-wide aggregation ever happens, revisit it — both collectors write through
`store.ts` rather than inlining SQL, so a backend change is a re-import.

## Tests

```sh
npm test          # 27 assertions, deterministic, free
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
  [content flags](#the-content-flags-are-not-optional-here) are on; transcripts
  include them regardless. The file is unencrypted. Treat it as sensitive —
  turning on `OTEL_LOG_USER_PROMPTS` or `OTEL_LOG_TOOL_CONTENT` puts a second
  copy of that material somewhere you may not think to check before sharing a
  directory or a backup.
- **The sink binds to loopback and does no authentication.** Don't expose it.
- Database lives at `~/.claude/telemetry/telemetry.db`, overridable with
  `CLAUDE_TELEMETRY_DB`.

## Releasing

Published to npm on a `v*` tag via GitHub OIDC trusted publishing — no
`NPM_TOKEN`, with provenance attestation generated automatically.

The tag is the version. `package.json` carries `0.0.0` and CI writes the real
number from the tag, so releasing is `git tag v0.1.2 && git push origin v0.1.2`
and nothing else — no bump commit to forget, and no way for the tag and the
manifest to disagree. `.claude-plugin/plugin.json` is the exception: the
marketplace clones this repo rather than installing the tarball, so its version
is committed, and the workflow refuses to publish if it does not match the tag.

### The tarball is also a valid plugin payload

It ships `.claude-plugin/`, `skills/` and both `src/` and `dist/`, so a
marketplace may list this with an npm source:

```json
{ "source": "npm", "package": "claude-local-telemetry", "version": "0.1.3" }
```

`src/` is in `files` specifically to make that work. `plugin.json` points the
MCP server at `${CLAUDE_PLUGIN_ROOT}/src/cli.ts`, which a git checkout has and
a `dist`-only tarball would not — an npm install would then have produced a
working skill and a dead MCP server, with no error to explain it. Shipping both
layouts costs a few KB and removes the failure mode.

Pin an exact `version` rather than a range if you publish a measured
context-cost number for the plugin, since a range makes the installed tree
unknowable. A git source with a `sha` is equally exact and is the better fit
when you want the tree you can read to be the tree that installs.

See [RELEASING.md](RELEASING.md).

## Licence

[MIT](LICENSE)
