# Changelog

## 0.1.0 — 2026-08-15

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
- `src/mcp.ts` — nine read-only `telemetry_*` tools over stdio.
- `src/api.ts` — HTTP API for the dashboard.
- `test/` — 16 assertions over synthetic fixtures.

Validated against live sessions: cost reconciles exactly against the figure the
CLI reports, and the span tree reconstructs with correct parent/child nesting.
