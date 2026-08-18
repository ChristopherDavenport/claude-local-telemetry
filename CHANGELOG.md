# Changelog

## 0.3.0 — 2026-08-18

Cost by model was answerable; cost by *what an agent was doing* was not. That is
the question a model-routing decision asks, and the gap was almost all of the
money — workflow agents were 94% of subagent spend on the store this was
measured against, and had no `agent_runs` row at all.

- **Workflow agents get a task, not just a cost.** `agent_runs` is built from
  the parent's `Agent` tool call, which carries the spawn parameters. A workflow
  agent is spawned by the runtime, so there is no such call, and the importer
  said so — it passed `null` for `workflow_run_id` with a comment explaining
  why. Those agents existed only as `api_requests` rows with an `agent_id`
  recovered from the transcript path. The runtime does record the intent, in
  `<project>/<session>/workflows/<runId>.json`, whose `workflowProgress` array
  carries the label the script passed, the resolved model, the phase, tokens,
  tool calls, retry count and queue timings. Nothing read that file. Backfill
  now does, after the transcripts, so the manifest upserts onto rows they
  already established: transcript wins on identity and measured totals, manifest
  wins on intent. On the store this was written against, `agent_runs` went from
  200 rows to 599, of which 399 gained a label and phase they never had.
- **New read: `telemetry_agent_tasks`** (`agentTasks()`), grouped by phase,
  label, workflow or model. It reports cache-read against output tokens, because
  that ratio is the routing signal rather than a curiosity: every phase measured
  reads 500–1400 tokens per token written, so these bills are paid on the input
  side, which is the axis the cheaper models are cheaper on. It also surfaces
  retries — a retry is paid twice, so a task that retries often is a prompt
  problem wearing a model-price costume — and the worst queue wait, which
  separates a phase that was slow from one that was throttled.

**Schema v4.** `agent_runs` gains `phase`, `phase_index`, `attempt`,
`queued_ms`, `prompt_preview` and `result_preview`; `workflow_runs` gains the
run's own totals, kept beside the summed per-agent figures rather than replacing
them — a disagreement between the two means an agent whose transcript never
landed, and merging would hide it.

**Upgrading.** A 0.2.x store is v3 and read-only callers refuse it until the
columns exist. The launchd sink opens through `init()` and migrates it on its
next export, so in the normal setup this resolves itself; otherwise the refusal
names the exact command (`claude-local-telemetry init --db <path>`, idempotent).
Re-run `backfill` afterwards to populate the new columns from manifests already
on disk.

## 0.2.1 — 2026-08-17

Two defects in 0.2.0, both found by running the acceptance tests against a real
store rather than a fixture. Neither corrupts data; both quietly report the
wrong thing, which on a ledger is the worse failure.

- **`init` no longer moves `schema_version` backwards.** It upserted its own
  version unconditionally, so an older build sharing the store — a launchd sink
  a release or two behind, which is the normal state of affairs — restamped a
  newer marker down to its own. Nothing is lost when that happens, because an
  old build never touches tables it does not know about, but `openForRead` then
  refuses a store whose data is entirely intact and every `campaigns` command
  reports it as too old. The marker now records the highest schema ever applied.
- **`campaigns harvest` counts pull requests, not attribution rows.** Artifact
  attribution is a window-based join, so several campaigns can legitimately
  claim one pull request — three did, on the store this was measured against.
  The summary reported those rows as though each were a distinct artifact: 65
  merged rows for 38 merged pull requests, which understates cost per shipped
  change by 1.7x. Both numbers are now reported, the distinct count leads, and
  the gap between them is stated rather than left to be inferred. `HarvestResult`
  gains `distinctArtifacts`, `distinctMerged`, `distinctClosed` and
  `distinctOpen`; the existing fields keep their row semantics.

No schema change — a 0.2.0 store needs no migration.

## 0.2.0 — 2026-08-17

The store could say what work cost and not whether any of it was kept. This
release adds the missing half: a derived unit of work, priced, with its
outcome attached and a name a human recognises.

- **Campaigns.** A campaign is sessions sharing a project close together in
  time, transitively — derived from `api_requests.cwd` and session timing, never
  entered by hand. A ticket-shaped unit was not available: over 27 days on the
  store this was built against, 80% of sessions ran on `HEAD` or `main` and not
  one branch name was ticket-shaped. Four rules keep it honest, each because the
  obvious version was wrong on real data — scratch directories link everything,
  a cwd is not a project (a linked worktree *is* its own top level, so
  `--show-toplevel` reported one campaign as 57 "projects"), a non-repo parent
  of other projects is a container, and a period of silence ends a campaign.
- **`campaigns price`.** Fills `cost_est_usd` for the rows that have exact
  tokens and no price — which is 99.6% of them, because the sink only sees
  sessions that ran while it was up. It lands *beside* `cost_usd`, never inside
  it: overwriting the provider's figure with a computed one would erase the
  distinction the store exists to keep. Cache tokens are priced at their own
  rates, which is not a detail — cache reads outnumber fresh input 8.2B to 0.5B.
  Validated against the 1,016 rows carrying both figures: largest single-row
  error $0.0000000000.
- **`campaigns harvest`.** Records merged / closed / open pull requests per
  campaign, scoped to the authenticated author. `no artifact` is deliberately
  distinct from `abandoned`: the first may be research, the second was rejected.
- **`campaigns label`.** Names each campaign from `sessions.first_prompt`, which
  backfill now extracts. Getting the material was the work — only 2 of 114
  campaigns had any prompt text before, and a transcript's first `user` record
  is usually a caveat block, command output, or a tool result rather than the
  operator. Coverage after: 86% of sessions, zero wrapper text.
- **The edge graph is kept, not just the clusters.** `session_edges` stores
  every in-window pair with the inputs to a weight, so a different clustering is
  a different traversal rather than a re-derivation. `--strategy communities`
  runs deterministic label propagation over it and reports modularity.
- **Schema v3**, with `cost_est_usd`, `sessions.first_prompt`,
  `campaigns.label_model`, and the campaign tables. The version check is
  one-directional, so an older reader opens a v3 store without complaint.

Known limits, stated because they bound what the numbers mean: the estimate uses
first-party list rates, so it compares campaigns rather than reconciling a bill;
artifact attribution is by repository and time window, so unrelated work of your
own in the same repo during the window still attaches; and clustering splits on
*when*, not *purpose* — measured on real data, the largest cluster is 97% dense
with uniform weights, so no community algorithm can separate it and a
content-derived signal is what the problem actually needs.

## 0.1.3 — 2026-08-16

Setup documentation rewritten against a first real install, which surfaced a
gap that made the documented happy path produce a degraded store.

- **The content flags are in the setup block now.** Every OTel content
  attribute is off by default, so following the old instructions exactly gave
  you a `telemetry_tool_audit` where tool, MCP, skill and workflow names were
  all `<REDACTED>`, with nothing saying why. `OTEL_LOG_TOOL_DETAILS` is
  required for the audit surface to be readable; the rest are fidelity, tabled
  with what each one exposes so the privacy trade is a decision.
- **Running the sink as a service.** `sink &` dies with the terminal and
  `cost_usd` only covers the period the sink was up, so uptime is the whole
  game. Covers launchd and systemd, and the two failure modes that are silent:
  a service manager's minimal `PATH` cannot resolve a version-manager Node, and
  the plugin cache is a managed, versioned directory that moves on update — so
  point the unit at a global install and an absolute Node path.
- **What npm is for.** The package is the stable binary for the daemon; the
  marketplace is the plugin. Separate channels, stated as such.
- **`src/**/*.ts` is in `files`.** The tarball shipped only `dist/`, while
  `plugin.json` points the MCP server at `${CLAUDE_PLUGIN_ROOT}/src/cli.ts`, so
  a marketplace using an `npm` plugin source installed a working skill and
  fourteen dead MCP tools with no error. Both layouts now ship (~114 KB more,
  240 KB unpacked).
- **`alias derive` on a fresh sink.** Its `learned 0 mapping(s)` output is
  correct, not a failure — the mapping needs overlap between the two sources.
  Documented, along with `bySource` in `telemetry_overview` as the canonical
  "is the sink receiving" check, and the fact that `env` in `settings.json` is
  read at startup.

## 0.1.2 — 2026-08-16

The tag is now the version. Releasing is `git tag` and a push; `package.json`
carries `0.0.0` in the repo and CI writes the real number from the tag before
it builds. There is no bump commit, so there is nothing to forget and no way
for the tag and the manifest to disagree.

**Fixed: the MCP server reported the wrong version.** `serverInfo.version` was
hardcoded, and said `0.1.0` for the whole of the `0.1.1` release. It now reads
`.claude-plugin/plugin.json` at runtime — the one manifest correct in both
channels, since the tag only reaches `package.json` inside CI and a marketplace
clone runs straight from `src/`.

`.claude-plugin/plugin.json` had drifted for the same reason, and is now
enforced: the release workflow refuses to publish if it does not equal the tag.
It stays hand-maintained because the marketplace clones this repo and never
sees the tarball, so a version written at pack time would not reach plugin
users.

Also: a prerelease tag now publishes under `next` rather than capturing
`latest`, the release workflow can be dispatched manually as a dry run, and the
packed tarball's version is asserted against the tag before publishing.

## 0.1.1 — 2026-08-16

First release published by CI, and therefore the first carrying a **provenance
attestation**: a signed, verifiable statement of which commit and which workflow
run produced the tarball. Verify it with `npm audit signatures`.

No functional change. `0.1.0` is identical code — it went out by hand because a
trusted publisher can only be configured for a package that already exists, so
the first version can never be the one that proves the mechanism works. This is
that proof.

- `RELEASING.md` — the bootstrap section is marked done rather than reading as
  outstanding work, records that 2FA at the terminal is now the expected path
  for a manual publish rather than a misconfiguration, and warns that a Node
  installed without its bundled npm leaves a much older client on `PATH`.

## 0.1.0 — 2026-08-16

First release. Extracted from `christopherdavenport-marketplace` into its own
repository: it owns a daemon, a database and a schema, which is application
shaped rather than skill shaped, and it wants a build toolchain the marketplace
deliberately does not have.

TypeScript on Node 24. `node:sqlite` and native type-stripping mean the runtime
installs nothing and builds nothing; the only devDependency is `tsc`.

- `src/sink.ts` — OTLP/HTTP-JSON receiver. Metrics, logs and traces.
- `src/backfill.ts` — imports `~/.claude/projects/**/*.jsonl`. Idempotent.
- `src/store.ts` — SQLite schema, WAL, STRICT tables.
- `src/queries.ts` — the analytical surface, shared by the MCP server and the API.
- `src/alias.ts` — derives `plugin_alias` by joining the two sources on
  `request_id`, which is what un-blinds per-plugin spend. The only module
  here that writes.
- `src/mcp.ts` — fourteen read-only `telemetry_*` tools over stdio.
- `src/api.ts` — HTTP API for the dashboard.
- `ui/` — a Lit dashboard over that API. Not shipped in the npm tarball; it is
  built from a clone, and `api --ui DIR` serves it.
- `test/` — 27 assertions over synthetic fixtures.

Validated against live sessions: cost reconciles exactly against the figure the
CLI reports, and the span tree reconstructs with correct parent/child nesting.
