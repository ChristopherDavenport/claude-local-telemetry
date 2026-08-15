/**
 * SQLite store for local Claude Code telemetry.
 *
 * Uses `node:sqlite`, which ships with Node 24 — so the server keeps the
 * property that made the first version worth having: no runtime dependencies at
 * all. It is flagged experimental and prints a warning; `--no-warnings` in the
 * CLI shebang keeps that out of MCP stdio, where stray stderr is merely noisy
 * but stray stdout would corrupt the protocol.
 *
 * Design notes that are not obvious
 * ---------------------------------
 * **Two sources, one schema.** OTel and the transcripts describe the same events
 * with different fidelity and different blind spots, so rows carry a `source`
 * column and are merged on natural keys rather than kept apart. OTel knows
 * `cost_usd` and attribution; transcripts know the real skill and agent names
 * that OTel redacts. Neither alone answers "what did this plugin cost me".
 *
 * **Attribution is redacted in OTel.** Every non-official plugin reports as the
 * literal string `third-party` on `plugin.name`, `skill.name` and
 * `marketplace.name`. `plugin_id_hash` is stable and distinct per plugin, so
 * `plugin_alias` maps hash to real name and `api_requests.plugin_resolved` is
 * the column worth trusting.
 *
 * **WAL and busy_timeout are not optional.** The sink writes on every export
 * interval while the API or an MCP query may be reading, and the default
 * journal mode turns that into `database is locked`.
 *
 * **Timestamps are ISO-8601 UTC text**, not epoch. SQLite compares them
 * lexicographically, so `WHERE ts > ?` works without converting every row, and
 * the file stays readable in a plain sqlite3 shell.
 */

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCHEMA_VERSION = 1;

export function defaultDbPath(): string {
  return process.env["CLAUDE_TELEMETRY_DB"]
    ?? join(homedir(), ".claude", "telemetry", "telemetry.db");
}

/** Every table a reader may touch. Used to detect a store from an older version. */
export const TABLES = [
  "api_requests", "tool_calls", "events", "spans", "metrics",
  "sessions", "plugin_loads", "plugin_alias", "hook_runs",
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

-- One row per API call. The money table.
CREATE TABLE IF NOT EXISTS api_requests (
    request_id       TEXT PRIMARY KEY,
    ts               TEXT NOT NULL,
    session_id       TEXT,
    model            TEXT,
    cost_usd         REAL,
    input_tokens     INTEGER,
    output_tokens    INTEGER,
    cache_read       INTEGER,
    cache_creation   INTEGER,
    duration_ms      INTEGER,
    query_source     TEXT,
    speed            TEXT,
    effort           TEXT,
    agent_name       TEXT,
    skill_name       TEXT,
    plugin_name      TEXT,
    marketplace_name TEXT,
    plugin_resolved  TEXT,
    mcp_server       TEXT,
    mcp_tool         TEXT,
    cwd              TEXT,
    git_branch       TEXT,
    source           TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_api_ts      ON api_requests(ts);
CREATE INDEX IF NOT EXISTS ix_api_session ON api_requests(session_id);
CREATE INDEX IF NOT EXISTS ix_api_model   ON api_requests(model);
CREATE INDEX IF NOT EXISTS ix_api_plugin  ON api_requests(plugin_resolved);
-- Covering indexes for the group-bys the UI runs on every page load. Measured:
-- they take the heaviest aggregate over 1.7M rows from ~800ms to ~130ms.
CREATE INDEX IF NOT EXISTS ix_api_day_cost   ON api_requests(substr(ts,1,10), cost_usd);
CREATE INDEX IF NOT EXISTS ix_api_model_cost ON api_requests(model, cost_usd, input_tokens);

-- Audit surface: what the agent did, and who let it.
CREATE TABLE IF NOT EXISTS tool_calls (
    id              INTEGER PRIMARY KEY,
    ts              TEXT NOT NULL,
    session_id      TEXT,
    tool_use_id     TEXT,
    tool_name       TEXT,
    success         INTEGER,
    duration_ms     INTEGER,
    decision        TEXT,
    decision_source TEXT,
    error_type      TEXT,
    input_bytes     INTEGER,
    result_bytes    INTEGER,
    mcp_scope       TEXT,
    cwd             TEXT,
    source          TEXT NOT NULL,
    UNIQUE(tool_use_id, source)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_tool_ts   ON tool_calls(ts);
CREATE INDEX IF NOT EXISTS ix_tool_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS ix_tool_sess ON tool_calls(session_id);

-- Everything else OTel emits, kept generically so a new event name in a future
-- CLI release lands intact rather than being dropped on the floor. UNIQUE across
-- the tuple because backfill is re-run routinely and events have no natural id.
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY,
    ts         TEXT NOT NULL,
    session_id TEXT,
    name       TEXT NOT NULL,
    attrs      TEXT NOT NULL,
    source     TEXT NOT NULL,
    UNIQUE(ts, session_id, name, attrs, source)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_ev_ts   ON events(ts);
CREATE INDEX IF NOT EXISTS ix_ev_name ON events(name);
CREATE INDEX IF NOT EXISTS ix_ev_sess ON events(session_id);

CREATE TABLE IF NOT EXISTS spans (
    span_id     TEXT PRIMARY KEY,
    trace_id    TEXT NOT NULL,
    parent_id   TEXT,
    name        TEXT NOT NULL,
    ts          TEXT NOT NULL,
    duration_ms REAL,
    session_id  TEXT,
    attrs       TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_span_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS ix_span_name  ON spans(name);
CREATE INDEX IF NOT EXISTS ix_span_ts    ON spans(ts);

CREATE TABLE IF NOT EXISTS metrics (
    id    INTEGER PRIMARY KEY,
    ts    TEXT NOT NULL,
    name  TEXT NOT NULL,
    value REAL,
    attrs TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_metric_name_ts ON metrics(name, ts);

CREATE TABLE IF NOT EXISTS sessions (
    session_id  TEXT PRIMARY KEY,
    started_at  TEXT,
    ended_at    TEXT,
    cwd         TEXT,
    git_branch  TEXT,
    entrypoint  TEXT,
    app_version TEXT,
    source      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_sess_started ON sessions(started_at);

-- plugin_loaded, one row per (plugin, session). Raw material for the
-- hash -> real-name map, because OTel will not give us the name directly.
CREATE TABLE IF NOT EXISTS plugin_loads (
    id             INTEGER PRIMARY KEY,
    ts             TEXT NOT NULL,
    session_id     TEXT,
    plugin_id_hash TEXT,
    plugin_name    TEXT,
    marketplace    TEXT,
    scope          TEXT,
    version        TEXT,
    skill_count    INTEGER,
    agent_count    INTEGER,
    command_count  INTEGER,
    has_hooks      INTEGER,
    has_mcp        INTEGER,
    UNIQUE(session_id, plugin_id_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_pl_hash ON plugin_loads(plugin_id_hash);

-- Hook executions. A table of its own because num_errors is the highest-value
-- signal in the store and needs to be cheap to query.
--
-- Per the hooks contract a hook exiting non-zero with anything other than 2 is a
-- *non-blocking error*: the tool call proceeds. So a hook can fail on every
-- invocation while the session looks completely normal. That is how two of three
-- hooks in a companion safety plugin ran for two releases without ever
-- executing -- found here, by num_errors > 0, not by any test.
CREATE TABLE IF NOT EXISTS hook_runs (
    id            INTEGER PRIMARY KEY,
    ts            TEXT NOT NULL,
    session_id    TEXT,
    prompt_id     TEXT,
    hook_event    TEXT,
    hook_name     TEXT,
    hook_source   TEXT,
    num_hooks     INTEGER,
    num_success   INTEGER,
    num_blocking  INTEGER,
    num_errors    INTEGER,
    num_cancelled INTEGER,
    duration_ms   INTEGER,
    UNIQUE(ts, session_id, hook_name)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_hook_ts     ON hook_runs(ts);
CREATE INDEX IF NOT EXISTS ix_hook_errors ON hook_runs(num_errors);
CREATE INDEX IF NOT EXISTS ix_hook_name   ON hook_runs(hook_name);

-- The de-anonymisation map. Hand-built or inferred.
CREATE TABLE IF NOT EXISTS plugin_alias (
    plugin_id_hash TEXT PRIMARY KEY,
    plugin_name    TEXT NOT NULL,
    marketplace    TEXT,
    confidence     TEXT NOT NULL,
    noted_at       TEXT
) STRICT;
`;

export interface OpenOptions {
  readonly?: boolean;
}

export function connect(dbPath?: string, opts: OpenOptions = {}): DatabaseSync {
  const path = dbPath ?? defaultDbPath();
  if (!opts.readonly) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, opts.readonly ? { readOnly: true } : {});
  if (!opts.readonly) db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");
  return db;
}

export function init(dbPath?: string): DatabaseSync {
  const db = connect(dbPath);
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO meta(key, value) VALUES('schema_version', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(SCHEMA_VERSION));
  return db;
}

/**
 * Open read-only, refusing a store written by an older version.
 *
 * The raw error for a missing table is `no such table: hook_runs`, which tells
 * the reader nothing about what to do. A read-only handle cannot migrate, so
 * say what will.
 */
export function openForRead(dbPath?: string): DatabaseSync {
  const path = dbPath ?? defaultDbPath();
  if (!existsSync(path)) {
    throw new Error(
      `no telemetry database at ${path}. Run \`claude-telemetry backfill\` to ` +
      "import existing transcripts, or `claude-telemetry sink` to collect live sessions.",
    );
  }
  const db = connect(path, { readonly: true });
  const have = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((r) => r.name),
  );
  const missing = TABLES.filter((t) => !have.has(t));
  if (missing.length) {
    db.close();
    throw new Error(
      `${path} predates this version — missing ${missing.join(", ")}. ` +
      `Run: claude-telemetry init --db ${path}  (idempotent; adds the new tables ` +
      "and leaves existing rows alone)",
    );
  }
  return db;
}

export interface Stats {
  rows: Record<string, number>;
  range: { from: string | null; to: string | null };
  totalCostUsd: number;
  bySource: Record<string, number>;
}

export function stats(db: DatabaseSync): Stats {
  const rows: Record<string, number> = {};
  for (const t of TABLES) {
    const r = db.prepare(`SELECT count(*) AS c FROM ${t}`).get() as { c: number };
    rows[t] = r.c;
  }
  const r = db.prepare(
    "SELECT min(ts) AS lo, max(ts) AS hi, sum(cost_usd) AS cost FROM api_requests",
  ).get() as { lo: string | null; hi: string | null; cost: number | null };
  const bySource: Record<string, number> = {};
  for (const s of db.prepare(
    "SELECT source, count(*) AS c FROM api_requests GROUP BY source",
  ).all() as Array<{ source: string; c: number }>) {
    bySource[s.source] = s.c;
  }
  return {
    rows,
    range: { from: r.lo, to: r.hi },
    totalCostUsd: r.cost ?? 0,
    bySource,
  };
}
