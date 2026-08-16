# Changelog

## Unreleased

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
