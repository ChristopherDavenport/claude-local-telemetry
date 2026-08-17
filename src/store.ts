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

export const SCHEMA_VERSION = 3;

export function defaultDbPath(): string {
  return process.env["CLAUDE_TELEMETRY_DB"]
    ?? join(homedir(), ".claude", "telemetry", "telemetry.db");
}

/** Every table a reader may touch. Used to detect a store from an older version. */
export const TABLES = [
  "api_requests", "tool_calls", "events", "spans", "metrics",
  "sessions", "plugin_loads", "plugin_alias", "hook_runs",
  "agent_runs", "workflow_runs",
  "projects", "campaigns", "campaign_sessions", "campaign_projects",
  "session_edges", "campaign_artifacts",
] as const;

/**
 * Columns added after v1.
 *
 * A missing *table* is caught by the TABLES check; a missing *column* is not,
 * and would surface as `no such column: agent_id` from inside a query. These
 * are applied by `init()` and asserted by `openForRead()` via schema_version.
 *
 * They hang off the *turn* rather than the session on purpose. A subagent
 * transcript carries its parent's `sessionId`, or none at all — so an agent is
 * not a session, and `sessions.parent_session_id` would have been
 * self-referential. What an agent actually owns is a set of requests and tool
 * calls.
 */
const V2_COLUMNS: Record<string, Array<[name: string, decl: string]>> = {
  api_requests: [["agent_id", "TEXT"], ["workflow_run_id", "TEXT"],
                 ["plugin_id_hash", "TEXT"]],
  tool_calls: [["agent_id", "TEXT"], ["workflow_run_id", "TEXT"]],
};

/**
 * v3: a derived dollar figure, kept apart from the measured one.
 *
 * cost_usd is what the provider reported and exists on 0.4% of rows -- only
 * those the OTLP sink saw. Everything backfilled from a transcript has exact
 * token counts and no price. Writing an estimate into cost_usd would make the
 * two indistinguishable and quietly turn a measurement into a guess, so the
 * estimate gets its own column and every reader chooses which it wants.
 */
const V3_COLUMNS: Record<string, Array<[name: string, decl: string]>> = {
  api_requests: [["cost_est_usd", "REAL"]],
  // The session's opening ask, in the operator's own words. Only 2 of 114
  // campaigns had any prompt text from OTel -- that path is hours old and the
  // transcripts are the whole retention window -- so a campaign could be priced
  // and dated and still be unnameable. This is what makes it nameable.
  sessions: [["first_prompt", "TEXT"]],
};

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
    source           TEXT NOT NULL,
    -- Which subagent made this call, and which workflow run it belonged to.
    -- Derived from the transcript's path. query_source says main vs subagent;
    -- these say *which* one. This is measured agent cost, as opposed to the
    -- totals the parent reported in agent_runs.
    agent_id         TEXT,
    workflow_run_id  TEXT,
    -- OTel knows the hash but not the name; the transcript knows the name but
    -- not the hash. Storing the hash on the request is what lets the two be
    -- joined on request_id to learn the mapping, instead of guessing it.
    plugin_id_hash   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS ix_api_agent   ON api_requests(agent_id);
CREATE INDEX IF NOT EXISTS ix_api_hash    ON api_requests(plugin_id_hash);
CREATE INDEX IF NOT EXISTS ix_api_wf      ON api_requests(workflow_run_id);
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
    agent_id        TEXT,
    workflow_run_id TEXT,
    UNIQUE(tool_use_id, source)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_tool_agent ON tool_calls(agent_id);
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

-- The spawn as the *parent* saw it, which is not the same thing as the agent's
-- transcript and can exist without one: a backgrounded agent returns an
-- acknowledgement immediately and its totals never come back to the caller.
-- agent_type, team_name and the usage totals only exist here.
CREATE TABLE IF NOT EXISTS agent_runs (
    agent_id          TEXT PRIMARY KEY,
    ts                TEXT NOT NULL,
    parent_session_id TEXT,
    workflow_run_id   TEXT,
    agent_type        TEXT,
    label             TEXT,
    team_name         TEXT,
    model             TEXT,
    status            TEXT,
    is_async          INTEGER,
    description       TEXT,
    total_tokens      INTEGER,
    duration_ms       INTEGER,
    tool_uses         INTEGER,
    source            TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_agent_parent ON agent_runs(parent_session_id);
CREATE INDEX IF NOT EXISTS ix_agent_team   ON agent_runs(team_name);
CREATE INDEX IF NOT EXISTS ix_agent_wf     ON agent_runs(workflow_run_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id      TEXT PRIMARY KEY,
    ts          TEXT NOT NULL,
    name        TEXT,
    session_id  TEXT,
    script_path TEXT,
    summary     TEXT,
    source      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_wf_session ON workflow_runs(session_id);

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

-- A cwd resolved to the thing it is part of, so that /repo and /repo/sub, and
-- two clones of one repository under different parents, count as one project.
-- Populated by \`campaigns derive\`; cached because resolving it shells out to
-- git once per distinct directory and most of them never change.
--
-- kind records how the key was obtained, because the three are not equally
-- trustworthy and a later reader should be able to tell them apart:
--   remote    the git remote URL, normalised. Merges separate clones.
--   toplevel  the work-tree root. Merges subdirectories, not clones.
--   path      the cwd verbatim. The directory is gone or was never a repo.
--   ephemeral scratch (/tmp, /var/folders). Deliberately NOT a project: these
--             are shared by unrelated work and would link it all together.
CREATE TABLE IF NOT EXISTS projects (
    cwd         TEXT PRIMARY KEY,
    project_key TEXT,
    kind        TEXT NOT NULL,
    resolved_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_proj_key ON projects(project_key);

-- A campaign is the unit of work this operator actually has: a set of sessions
-- spanning several repositories over several days that share one purpose. It
-- is derived, never entered. Nothing here is written by hand -- the inputs are
-- session timing and the projects each session touched, both of which are
-- recorded as a side effect of working.
--
-- The ticket-shaped alternative was rejected on evidence: over 27 days, 80% of
-- sessions ran on HEAD or main and not one branch name was ticket-shaped. A
-- ledger keyed on something that is not there measures nothing.
-- The graph the clustering runs on, kept rather than thrown away.
--
-- Connected components plus a quiet-period split is the first strategy, not the
-- last one: it splits on *when*, and two unrelated efforts sharing one
-- repository on the same afternoon still land together. Fixing that means
-- weighting edges and cutting weak ones, or running community detection.
-- Neither can be done later if only the resulting clusters were stored, so the
-- edges and the inputs to a weight are persisted here and the clustering reads
-- from this table. A new strategy is then a different traversal of the same
-- graph, not a re-derivation -- and campaigns.strategy records which one
-- produced a row, so two strategies can be compared on identical input.
--
-- The weight column is the current formula and is deliberately recomputable:
-- the raw inputs it is derived from are stored beside it.
CREATE TABLE IF NOT EXISTS session_edges (
    a               TEXT NOT NULL,          -- lexically smaller session_id
    b               TEXT NOT NULL,
    shared_projects INTEGER NOT NULL,
    gap_seconds     INTEGER NOT NULL,       -- 0 when the sessions overlap
    weight          REAL NOT NULL,
    PRIMARY KEY (a, b)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_edge_weight ON session_edges(weight);
CREATE INDEX IF NOT EXISTS ix_edge_b ON session_edges(b);

CREATE TABLE IF NOT EXISTS campaigns (
    campaign_id   TEXT PRIMARY KEY,
    strategy      TEXT NOT NULL,
    label         TEXT,
    started_at    TEXT NOT NULL,
    ended_at      TEXT NOT NULL,
    session_count INTEGER NOT NULL,
    project_count INTEGER NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd      REAL,
    derived_at    TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_camp_started ON campaigns(started_at);

CREATE TABLE IF NOT EXISTS campaign_sessions (
    campaign_id TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    PRIMARY KEY (campaign_id, session_id)
) STRICT;

-- What a campaign produced. See src/artifacts.ts for why merged/closed/open is
-- a split of spend rather than a verdict, and why harvested_at is on the row:
-- "open" is a fact about the moment it was observed, not about the work.
CREATE TABLE IF NOT EXISTS campaign_artifacts (
    campaign_id  TEXT NOT NULL,
    kind         TEXT NOT NULL,          -- pr (commit, release: later)
    repo         TEXT NOT NULL,
    ref          TEXT NOT NULL,          -- pull request number
    state        TEXT,                   -- merged | closed | open
    title        TEXT,
    created_at   TEXT,
    resolved_at  TEXT,                   -- merged_at, else closed_at
    additions    INTEGER,
    deletions    INTEGER,
    url          TEXT,
    harvested_at TEXT NOT NULL,
    PRIMARY KEY (campaign_id, kind, repo, ref)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_art_state ON campaign_artifacts(state);

CREATE TABLE IF NOT EXISTS campaign_projects (
    campaign_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    PRIMARY KEY (campaign_id, project_key)
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

/** Columns of a table that already exists. */
function columnsOf(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((r) => r.name),
  );
}

/**
 * Bring an existing store up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` handles new tables but says nothing about new
 * columns on an old one, so those are added explicitly. SQLite's
 * `ADD COLUMN` is O(1) and does not rewrite the table, and every added column
 * is nullable with no default, so existing rows stay valid under STRICT.
 */
function migrate(db: DatabaseSync): void {
  // Each version's map is applied in turn rather than merged: two versions can
  // add columns to the same table, and a spread would silently drop the older
  // entry when both name it.
  for (const version of [V2_COLUMNS, V3_COLUMNS]) {
    for (const [table, cols] of Object.entries(version)) {
      const have = columnsOf(db, table);
      for (const [name, decl] of cols) {
        if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      }
    }
  }
}

export function init(dbPath?: string): DatabaseSync {
  const db = connect(dbPath);
  db.exec(SCHEMA);
  migrate(db);
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
      `no telemetry database at ${path}. Run \`claude-local-telemetry backfill\` to ` +
      "import existing transcripts, or `claude-local-telemetry sink` to collect live sessions.",
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
      `Run: claude-local-telemetry init --db ${path}  (idempotent; adds the new tables ` +
      "and leaves existing rows alone)",
    );
  }

  // A store can have every table and still predate a column. That failure would
  // otherwise surface from inside a query as `no such column`, which tells the
  // reader nothing about what to do; a read-only handle cannot migrate itself.
  const version = Number(
    (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      { value: string } | undefined)?.value ?? 0,
  );
  if (version < SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `${path} is schema v${version || "0"}; this build needs v${SCHEMA_VERSION}. ` +
      `Run: claude-local-telemetry init --db ${path}  (idempotent; adds the new columns ` +
      "and leaves existing rows alone). Re-run backfill afterwards to populate them.",
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
