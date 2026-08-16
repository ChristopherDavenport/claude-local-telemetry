# Changelog

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
