# Changelog

## 0.1.0 — 2026-08-15

First release. Extracted from `christopherdavenport-marketplace` into its own
repository: it owns a daemon, a database and a schema, which is application
shaped rather than skill shaped, and it wants a build toolchain the marketplace
deliberately does not have.

- `sink.py` — OTLP/HTTP-JSON receiver, stdlib only. Metrics, logs and traces.
- `backfill.py` — imports `~/.claude/projects/**/*.jsonl`. Idempotent.
- `store.py` — SQLite schema, WAL, STRICT tables.
- `mcp_server.py` — nine read-only `telemetry_*` tools over stdio, stdlib only.
- `evals/` — 20 assertions plus a mutation mode.

Validated against live sessions: cost reconciles exactly against the figure the
CLI reports, and the span tree reconstructs with correct parent/child nesting.
