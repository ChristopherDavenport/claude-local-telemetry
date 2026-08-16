/**
 * The analytical surface, shared by the MCP server and the UI's HTTP API.
 *
 * One module so the two interfaces cannot drift: a number the dashboard shows
 * and a number Claude reports should come from the same SQL, or one of them is
 * wrong and nobody finds out which.
 *
 * Everything here is read-only and takes an already-open handle.
 */

import type { DatabaseSync } from "node:sqlite";
import { stats as storeStats, TABLES } from "./store.ts";

export type Row = Record<string, unknown>;

const AGGS: Record<string, string> = {
  count: "count(*)",
  sum_cost: "sum(cost_usd)",
  sum_input: "sum(input_tokens)",
  sum_output: "sum(output_tokens)",
  sum_cache_read: "sum(cache_read)",
  sum_cache_creation: "sum(cache_creation)",
  avg_duration: "avg(duration_ms)",
  max_duration: "max(duration_ms)",
  sum_duration: "sum(duration_ms)",
};

const COST_GROUPS: Record<string, string> = {
  day: "substr(ts,1,10)",
  hour: "substr(ts,1,13)",
  model: "model",
  query_source: "query_source",
  plugin_resolved: "plugin_resolved",
  skill_name: "skill_name",
  agent_name: "agent_name",
  session_id: "session_id",
  cwd: "cwd",
  git_branch: "git_branch",
  speed: "speed",
  effort: "effort",
  // Added with schema v2. "what did each agent cost" is the first question the
  // agent data invites, and without these it could only be answered through
  // run_query — which returns one aggregate, not the cost-and-token breakdown
  // this returns per row.
  agent_id: "agent_id",
  workflow_run_id: "workflow_run_id",
  plugin_id_hash: "plugin_id_hash",
};

/** Exported for the test that runs every advertised option against a store. */
export const COST_GROUPS_FOR_TEST = COST_GROUPS;

const SELECT_ONLY = /^\s*select\b/i;
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|replace|reindex|analyze|begin|commit|rollback)\b/i;

function all(db: DatabaseSync, sql: string, params: unknown[] = [], limit = 200): Row[] {
  return (db.prepare(sql).all(...params as never[]) as Row[]).slice(0, limit);
}

export function overview(db: DatabaseSync) {
  const s = storeStats(db);
  return {
    rows: s.rows,
    timeRange: s.range,
    totalCostUsd: Math.round(s.totalCostUsd * 10000) / 10000,
    bySource: s.bySource,
    note:
      "Rows sourced from transcripts have no cost_usd — the transcripts do not " +
      "record it. Token counts there are exact. Only OTel-sourced rows carry " +
      "dollars, so cost totals cover the OTel period only.",
  };
}

export function cost(db: DatabaseSync, o: {
  groupBy?: string | undefined; since?: string | undefined; until?: string | undefined;
  limit?: number | undefined; sessionId?: string | undefined;
} = {}) {
  const key = o.groupBy ?? "model";
  const col = COST_GROUPS[key];
  if (!col) throw new Error(`group_by must be one of: ${Object.keys(COST_GROUPS).sort().join(", ")}`);
  const where = ["1=1"]; const params: unknown[] = [];
  if (o.since) { where.push("ts >= ?"); params.push(o.since); }
  if (o.until) { where.push("ts <= ?"); params.push(o.until); }
  if (o.sessionId) { where.push("session_id = ?"); params.push(o.sessionId); }
  const limit = o.limit ?? 50;
  const sql =
    `SELECT ${col} AS grp, count(*) AS n, sum(cost_usd) AS cost_usd,` +
    ` sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,` +
    ` sum(cache_read) AS cache_read, sum(cache_creation) AS cache_creation` +
    ` FROM api_requests WHERE ${where.join(" AND ")}` +
    ` GROUP BY grp ORDER BY COALESCE(sum(cost_usd),0) DESC, sum(input_tokens) DESC LIMIT ?`;
  return { groupBy: key, rows: all(db, sql, [...params, limit], limit) };
}

export function sessions(db: DatabaseSync, o: {
  since?: string | undefined; cwdLike?: string | undefined; limit?: number | undefined;
  sessionId?: string | undefined;
} = {}) {
  const where = ["1=1"]; const params: unknown[] = [];
  if (o.since) { where.push("s.started_at >= ?"); params.push(o.since); }
  // Parameterised, not interpolated. Before this the dashboard's session page
  // had to build `where=session_id='…'` as a string and guard it with a regex.
  if (o.sessionId) { where.push("s.session_id = ?"); params.push(o.sessionId); }
  if (o.cwdLike) { where.push("COALESCE(s.cwd, a.cwd) LIKE ?"); params.push(`%${o.cwdLike}%`); }
  const limit = o.limit ?? 25;
  const sql = `
    SELECT s.session_id, s.started_at, s.ended_at,
           COALESCE(s.cwd, MIN(a.cwd)) AS cwd,
           COALESCE(s.git_branch, MIN(a.git_branch)) AS branch,
           count(a.request_id) AS requests, sum(a.cost_usd) AS cost_usd,
           sum(a.input_tokens) AS input_tokens, sum(a.output_tokens) AS output_tokens,
           (SELECT count(*) FROM tool_calls t WHERE t.session_id = s.session_id) AS tool_calls
    FROM sessions s LEFT JOIN api_requests a ON a.session_id = s.session_id
    WHERE ${where.join(" AND ")}
    GROUP BY s.session_id ORDER BY s.started_at DESC LIMIT ?`;
  return { rows: all(db, sql, [...params, limit], limit) };
}

export function toolAudit(db: DatabaseSync, o: {
  toolName?: string | undefined; success?: boolean | undefined; decision?: string | undefined;
  since?: string | undefined; limit?: number | undefined;
  sessionId?: string | undefined; agentId?: string | undefined;
} = {}) {
  const where = ["1=1"]; const params: unknown[] = [];
  if (o.sessionId) { where.push("session_id = ?"); params.push(o.sessionId); }
  if (o.agentId) { where.push("agent_id = ?"); params.push(o.agentId); }
  if (o.toolName) { where.push("tool_name = ?"); params.push(o.toolName); }
  if (o.success !== undefined) { where.push("success = ?"); params.push(o.success ? 1 : 0); }
  if (o.decision) { where.push("decision = ?"); params.push(o.decision); }
  if (o.since) { where.push("ts >= ?"); params.push(o.since); }
  const w = where.join(" AND ");
  const limit = o.limit ?? 25;
  const rows = all(db,
    `SELECT ts, session_id, tool_name, success, duration_ms, decision, decision_source,` +
    ` error_type, input_bytes, result_bytes, cwd FROM tool_calls WHERE ${w}` +
    ` ORDER BY ts DESC LIMIT ?`, [...params, limit], limit);
  const summary = all(db,
    `SELECT tool_name, count(*) AS n, sum(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failures` +
    ` FROM tool_calls WHERE ${w} GROUP BY tool_name ORDER BY n DESC LIMIT 20`, params, 20);
  return { summary, rows };
}

/**
 * One node of an assembled trace. Spans nest; events are leaves placed inside
 * the span that was running when they were emitted.
 *
 * `kind` is a discriminant rather than two parallel arrays because the point of
 * the tree is the interleaving — an event's position relative to its sibling
 * spans is the information.
 */
export type TraceNode =
  | {
    kind: "span";
    span_id: string;
    parent_id: string | null;
    name: string;
    ts: string;
    duration_ms: number | null;
    attrs: Row;
    children: TraceNode[];
  }
  | { kind: "event"; name: string; ts: string; source: string; attrs: Row; children: [] };

/** Events are unbounded per session; a trace view is not a log viewer. */
const EVENT_CAP = 500;

/** ISO-8601 UTC text to epoch ms. The store writes `Z`; be tolerant anyway. */
function epoch(ts: string): number {
  const n = Date.parse(/[Z+]|[-]\d\d:\d\d$/.test(ts) ? ts : `${ts}Z`);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * The observability tree for one trace: nested spans, with the session's events
 * woven in at the point they occurred.
 *
 * Events carry no parent pointer — OTel logs and transcript records are not
 * spans — so they are placed by time containment: each lands in the *narrowest*
 * span whose window covers it, which is the deepest one. Anything outside every
 * span stays at the top level rather than being dropped, so the tree never
 * silently loses a record.
 *
 * A session with no spans still returns its events as a flat tree. That is the
 * normal case: spans need `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, and no
 * transcript has ever contained one. Returning nothing would make the feature
 * look broken when the data is merely a different shape.
 */
export function trace(db: DatabaseSync, o: {
  traceId?: string | undefined;
  sessionId?: string | undefined;
  includeEvents?: boolean | undefined;
}) {
  let traceId = o.traceId ?? null;
  let sessionId = o.sessionId ?? null;
  if (!traceId) {
    if (!sessionId) throw new Error("pass traceId or sessionId");
    const r = db.prepare(
      "SELECT trace_id FROM spans WHERE session_id=? ORDER BY ts DESC LIMIT 1",
    ).get(sessionId) as { trace_id: string } | undefined;
    traceId = r?.trace_id ?? null;
  }

  const spans = traceId
    ? db.prepare(
      "SELECT span_id, parent_id, trace_id, name, ts, duration_ms, session_id, attrs" +
      " FROM spans WHERE trace_id=? ORDER BY ts",
    ).all(traceId) as Array<{
      span_id: string; parent_id: string | null; trace_id: string; name: string;
      ts: string; duration_ms: number | null; session_id: string | null; attrs: string;
    }>
    : [];

  if (!sessionId) sessionId = spans.find((s) => s.session_id)?.session_id ?? null;

  // Bound events to the trace's own window when there are spans; otherwise the
  // whole session, because then the events *are* the trace.
  let events: Array<{ ts: string; name: string; attrs: string; source: string }> = [];
  if (o.includeEvents !== false && sessionId) {
    const clauses = ["session_id = ?"];
    const params: unknown[] = [sessionId];
    if (spans.length) {
      const lo = Math.min(...spans.map((s) => epoch(s.ts)));
      const hi = Math.max(...spans.map((s) => epoch(s.ts) + (s.duration_ms ?? 0)));
      clauses.push("ts >= ?", "ts <= ?");
      params.push(new Date(lo).toISOString(), new Date(hi).toISOString());
    }
    events = db.prepare(
      `SELECT ts, name, attrs, source FROM events WHERE ${clauses.join(" AND ")}` +
      ` ORDER BY ts LIMIT ${EVENT_CAP}`,
    ).all(...params as never[]) as typeof events;
  }

  // Place each event in the narrowest covering span.
  const windows = spans.map((s) => ({
    id: s.span_id,
    lo: epoch(s.ts),
    hi: epoch(s.ts) + (s.duration_ms ?? 0),
    width: s.duration_ms ?? 0,
  }));
  const eventsBySpan = new Map<string, TraceNode[]>();
  const rootEvents: TraceNode[] = [];
  for (const e of events) {
    const at = epoch(e.ts);
    let best: (typeof windows)[number] | null = null;
    for (const w of windows) {
      if (at < w.lo || at > w.hi) continue;
      if (!best || w.width < best.width) best = w;
    }
    const node: TraceNode = {
      kind: "event", name: e.name, ts: e.ts, source: e.source,
      attrs: JSON.parse(e.attrs) as Row, children: [],
    };
    if (best) {
      if (!eventsBySpan.has(best.id)) eventsBySpan.set(best.id, []);
      eventsBySpan.get(best.id)!.push(node);
    } else {
      rootEvents.push(node);
    }
  }

  const known = new Set(spans.map((s) => s.span_id));
  const byParent = new Map<string | null, typeof spans>();
  for (const s of spans) {
    // A parent outside this trace would orphan the subtree; hoist it to the root
    // instead of dropping it.
    const k = s.parent_id && known.has(s.parent_id) ? s.parent_id : null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(s);
  }

  const byTime = (a: TraceNode, b: TraceNode) => epoch(a.ts) - epoch(b.ts);
  const build = (pid: string | null): TraceNode[] =>
    (byParent.get(pid) ?? []).map((s): TraceNode => ({
      kind: "span",
      span_id: s.span_id,
      parent_id: s.parent_id,
      name: s.name,
      ts: s.ts,
      duration_ms: s.duration_ms,
      attrs: JSON.parse(s.attrs) as Row,
      children: [...build(s.span_id), ...(eventsBySpan.get(s.span_id) ?? [])].sort(byTime),
    }));

  const tree = [...build(null), ...rootEvents].sort(byTime);

  return {
    traceId,
    sessionId,
    spanCount: spans.length,
    eventCount: events.length,
    truncatedEvents: events.length === EVENT_CAP,
    tree,
    ...(spans.length ? {} : {
      note:
        "no spans for this session — traces are a beta exporter and off unless " +
        "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1. Showing the session's events instead; " +
        "they carry no parentage, so the tree is flat.",
    }),
  };
}

/**
 * Traces, most recent first — the index the trace view drills in from.
 *
 * Duration comes from the root span rather than `max(duration_ms)`: the root is
 * the one span that by definition spans the whole trace, and a long child of a
 * short parent is a clock-skew artefact rather than a longer trace.
 */
export function traces(db: DatabaseSync, o: {
  since?: string | undefined; sessionId?: string | undefined; limit?: number | undefined;
} = {}) {
  const where = ["1=1"]; const params: unknown[] = [];
  if (o.since) { where.push("s.ts >= ?"); params.push(o.since); }
  if (o.sessionId) { where.push("s.session_id = ?"); params.push(o.sessionId); }
  const limit = o.limit ?? 50;
  const sql =
    "SELECT s.trace_id, min(s.ts) AS started_at, count(*) AS span_count," +
    " max(s.session_id) AS session_id," +
    " (SELECT r.name FROM spans r WHERE r.trace_id = s.trace_id AND r.parent_id IS NULL" +
    "   ORDER BY r.ts LIMIT 1) AS root_name," +
    " COALESCE((SELECT r.duration_ms FROM spans r WHERE r.trace_id = s.trace_id" +
    "   AND r.parent_id IS NULL ORDER BY r.ts LIMIT 1), max(s.duration_ms)) AS duration_ms" +
    ` FROM spans s WHERE ${where.join(" AND ")}` +
    " GROUP BY s.trace_id ORDER BY started_at DESC LIMIT ?";
  const rows = all(db, sql, [...params, limit], limit);
  return {
    rows,
    note: rows.length ? undefined : (
      "no spans in the store. Traces come only from the OTLP sink with " +
      "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1; backfilled transcripts contain none. " +
      "Session event timelines are still available via trace(sessionId)."
    ),
  };
}

export function runQuery(db: DatabaseSync, o: {
  table?: string | undefined; calculate?: string | undefined; breakdown?: string | undefined; where?: string | undefined;
  since?: string | undefined; until?: string | undefined; limit?: number | undefined;
} = {}) {
  const table = o.table ?? "api_requests";
  if (!(TABLES as readonly string[]).includes(table)) {
    throw new Error(`table must be one of: ${[...TABLES].sort().join(", ")}`);
  }
  const calc = o.calculate ?? "count";
  if (!AGGS[calc]) throw new Error(`calculate must be one of: ${Object.keys(AGGS).sort().join(", ")}`);
  const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((r) => r.name));
  const grp = o.breakdown && cols.has(o.breakdown) ? o.breakdown : undefined;
  if (o.breakdown && !grp) {
    throw new Error(`breakdown '${o.breakdown}' is not a column of ${table}: ${[...cols].sort().join(", ")}`);
  }
  const clauses = ["1=1"]; const params: unknown[] = [];
  if (o.since && cols.has("ts")) { clauses.push("ts >= ?"); params.push(o.since); }
  if (o.until && cols.has("ts")) { clauses.push("ts <= ?"); params.push(o.until); }
  if (o.where) {
    // Only a bare predicate; no subqueries, no statement separators.
    if (FORBIDDEN.test(o.where) || o.where.includes(";")) throw new Error("where clause rejected");
    clauses.push(`(${o.where})`);
  }
  const limit = o.limit ?? 50;
  const sql = `SELECT ${grp ? `${grp} AS grp, ` : ""}${AGGS[calc]} AS value FROM ${table}` +
    ` WHERE ${clauses.join(" AND ")}${grp ? " GROUP BY grp ORDER BY value DESC" : ""} LIMIT ?`;
  return { table, calculate: calc, breakdown: grp ?? null, rows: all(db, sql, [...params, limit], limit) };
}

/* ------------------------------------------------------------------ *
 * Agents, teams and workflows.
 *
 * Two different things are called "an agent run" here and they should not be
 * conflated:
 *
 * - **Reported** — `agent_runs`, one row per spawn as the *parent* saw it. It
 *   has the agent's type, team and model, and for a synchronous agent the
 *   totals it returned. A backgrounded agent acknowledges and never reports,
 *   so those totals are frequently null.
 * - **Measured** — `api_requests` tagged with `agent_id` from the transcript
 *   the agent actually wrote. This exists whether or not anything was reported,
 *   and it is the number to trust.
 *
 * The two id spaces do not use one format. A plain agent's transcript is named
 * for the same id the parent reported, so those join directly. A named teammate
 * is reported as `name@team` but files its transcript as `a<name>-<hash>`, so
 * those join on the label instead — a rule that resolved all 49 team members on
 * a real corpus, against 128 of 366 for exact matching alone.
 *
 * Queries lead with the measured side regardless, and treat the reported
 * metadata as enrichment that may be absent, rather than inner-joining and
 * silently dropping the agents whose ids do not line up.
 * ------------------------------------------------------------------ */

/** Does spawn row `r` describe the agent that wrote request row `a`? */
const MATCHES_AGENT =
  "(r.agent_id = a.agent_id OR (r.label IS NOT NULL AND a.agent_id LIKE 'a' || r.label || '-%'))";

/** Totals for an agent-tagged slice; input includes cache, which dominates. */
const AGENT_TOTALS =
  " count(*) AS requests, sum(a.cost_usd) AS cost_usd," +
  " sum(COALESCE(a.input_tokens,0) + COALESCE(a.cache_read,0) + COALESCE(a.cache_creation,0)) AS input_tokens," +
  " sum(a.output_tokens) AS output_tokens, min(a.ts) AS started_at, max(a.ts) AS ended_at";

export function workflows(db: DatabaseSync, o: {
  since?: string | undefined; sessionId?: string | undefined; limit?: number | undefined;
} = {}) {
  const where = ["1=1"]; const params: unknown[] = [];
  if (o.since) { where.push("w.ts >= ?"); params.push(o.since); }
  if (o.sessionId) { where.push("w.session_id = ?"); params.push(o.sessionId); }
  const limit = o.limit ?? 50;
  const rows = all(db,
    "SELECT w.run_id, w.ts AS started_at, w.name, w.session_id, w.script_path, w.summary," +
    " (SELECT count(DISTINCT a.agent_id) FROM api_requests a WHERE a.workflow_run_id = w.run_id) AS agents," +
    " (SELECT count(*) FROM api_requests a WHERE a.workflow_run_id = w.run_id) AS requests," +
    " (SELECT sum(a.cost_usd) FROM api_requests a WHERE a.workflow_run_id = w.run_id) AS cost_usd," +
    " (SELECT sum(COALESCE(a.input_tokens,0)+COALESCE(a.cache_read,0)+COALESCE(a.cache_creation,0))" +
    "    FROM api_requests a WHERE a.workflow_run_id = w.run_id) AS input_tokens," +
    " (SELECT sum(a.output_tokens) FROM api_requests a WHERE a.workflow_run_id = w.run_id) AS output_tokens" +
    ` FROM workflow_runs w WHERE ${where.join(" AND ")} ORDER BY w.ts DESC LIMIT ?`,
    [...params, limit], limit);
  return {
    rows,
    note: rows.length ? undefined : (
      "no workflow runs recorded. The Workflow tool writes its agents under " +
      "<project>/<session>/subagents/workflows/<runId>/, and backfill reads the run " +
      "id from that path; a store built before v2 will not have it until you re-run backfill."
    ),
  };
}

/** One workflow run, broken down by the agents that actually did the work. */
export function workflowRun(db: DatabaseSync, o: { runId?: string | undefined }) {
  if (!o.runId) throw new Error("pass runId");
  const run = db.prepare("SELECT * FROM workflow_runs WHERE run_id = ?").get(o.runId) as Row | undefined;
  const agents = all(db,
    `SELECT a.agent_id, ${AGENT_TOTALS},` +
    " (SELECT r.agent_type FROM agent_runs r WHERE r.agent_id = a.agent_id) AS agent_type," +
    " (SELECT r.label FROM agent_runs r WHERE r.agent_id = a.agent_id) AS label" +
    " FROM api_requests a WHERE a.workflow_run_id = ?" +
    " GROUP BY a.agent_id ORDER BY input_tokens DESC", [o.runId], 200);
  const tools = all(db,
    "SELECT tool_name, count(*) AS n FROM tool_calls WHERE workflow_run_id = ?" +
    " GROUP BY tool_name ORDER BY n DESC", [o.runId], 25);
  return { run: run ?? null, agentCount: agents.length, agents, tools };
}

/**
 * Agent runs, measured first.
 *
 * Starts from the requests each agent made and left-joins what the parent
 * reported, so a backgrounded agent that never reported still appears with its
 * real cost.
 */
export function agents(db: DatabaseSync, o: {
  sessionId?: string | undefined; teamName?: string | undefined;
  workflowRunId?: string | undefined; since?: string | undefined; limit?: number | undefined;
} = {}) {
  const where = ["a.agent_id IS NOT NULL"]; const params: unknown[] = [];
  if (o.since) { where.push("a.ts >= ?"); params.push(o.since); }
  if (o.sessionId) { where.push("a.session_id = ?"); params.push(o.sessionId); }
  if (o.workflowRunId) { where.push("a.workflow_run_id = ?"); params.push(o.workflowRunId); }
  if (o.teamName) {
    where.push(`EXISTS (SELECT 1 FROM agent_runs r WHERE r.team_name = ? AND ${MATCHES_AGENT})`);
    params.push(o.teamName);
  }
  const limit = o.limit ?? 50;

  // Metadata comes from correlated subqueries rather than a LEFT JOIN. The
  // match rule can hit more than one spawn row, and a join that multiplies rows
  // would silently inflate every sum in AGENT_TOTALS.
  const meta = (col: string) =>
    `(SELECT r.${col} FROM agent_runs r WHERE ${MATCHES_AGENT} LIMIT 1) AS ${col}`;
  const rows = all(db,
    `SELECT a.agent_id, a.session_id, a.workflow_run_id, ${AGENT_TOTALS},` +
    ` ${meta("agent_type")}, ${meta("label")}, ${meta("team_name")}, ${meta("model")},` +
    ` ${meta("status")},` +
    ` (SELECT r.total_tokens FROM agent_runs r WHERE ${MATCHES_AGENT} LIMIT 1) AS reported_tokens` +
    ` FROM api_requests a WHERE ${where.join(" AND ")}` +
    " GROUP BY a.agent_id ORDER BY input_tokens DESC LIMIT ?",
    [...params, limit], limit);

  // Spawns the parent recorded that produced no measurable turns — a
  // backgrounded agent still running, or one whose transcript is not on disk.
  const unmeasured = db.prepare(
    "SELECT count(*) AS n FROM agent_runs r WHERE NOT EXISTS" +
    " (SELECT 1 FROM api_requests a WHERE " + MATCHES_AGENT + ")",
  ).get() as { n: number };

  return { rows, spawnsWithoutTurns: unmeasured.n };
}

/** Named agents grouped by the team they were spawned into. */
export function teams(db: DatabaseSync, o: { since?: string | undefined; limit?: number | undefined } = {}) {
  const where = ["r.team_name IS NOT NULL"]; const params: unknown[] = [];
  if (o.since) { where.push("r.ts >= ?"); params.push(o.since); }
  const limit = o.limit ?? 50;
  const per = (expr: string) =>
    `sum((SELECT ${expr} FROM api_requests a WHERE ${MATCHES_AGENT}))`;
  const rows = all(db,
    "SELECT r.team_name, count(*) AS members," +
    " count(DISTINCT r.agent_type) AS agent_types, min(r.ts) AS started_at," +
    ` ${per("count(*)")} AS requests,` +
    ` ${per("sum(COALESCE(a.input_tokens,0)+COALESCE(a.cache_read,0)+COALESCE(a.cache_creation,0))")} AS input_tokens,` +
    ` ${per("sum(a.output_tokens)")} AS output_tokens,` +
    ` ${per("sum(a.cost_usd)")} AS cost_usd` +
    ` FROM agent_runs r WHERE ${where.join(" AND ")}` +
    " GROUP BY r.team_name ORDER BY members DESC LIMIT ?", [...params, limit], limit);
  return { rows };
}

export function pluginCosts(db: DatabaseSync) {
  const attributed = all(db,
    "SELECT COALESCE(plugin_resolved, plugin_name) AS plugin, count(*) AS n," +
    " sum(cost_usd) AS cost_usd FROM api_requests WHERE plugin_name IS NOT NULL" +
    " GROUP BY plugin ORDER BY cost_usd DESC", [], 50);
  const blinded = db.prepare(
    "SELECT count(*) AS n, sum(cost_usd) AS cost FROM api_requests" +
    " WHERE plugin_name = 'third-party' AND plugin_resolved IS NULL",
  ).get() as { n: number; cost: number | null };
  const invocations = all(db,
    "SELECT json_extract(attrs,'$.skill') AS skill," +
    " json_extract(attrs,'$.subagent_type') AS agent, count(*) AS n FROM events" +
    " WHERE name LIKE 'transcript.%_invoked' GROUP BY skill, agent ORDER BY n DESC LIMIT 40",
    [], 40);
  const hashes = all(db,
    "SELECT p.plugin_id_hash, p.plugin_name, p.marketplace, p.skill_count, p.agent_count," +
    " a.plugin_name AS resolved FROM plugin_loads p LEFT JOIN plugin_alias a" +
    " USING(plugin_id_hash) GROUP BY p.plugin_id_hash ORDER BY p.plugin_name", [], 100);
  const unresolved = hashes.filter((h) => h["plugin_name"] === "third-party" && !h["resolved"]).length;
  return {
    attributed, blinded: { requests: blinded.n, costUsd: blinded.cost },
    skillAgentInvocationsFromTranscripts: invocations, pluginHashes: hashes,
    note:
      `${unresolved} plugin hashes are still unmapped. OTel reports every ` +
      "non-official plugin as the literal 'third-party'; populate plugin_alias to " +
      "attribute their spend. Transcript-derived skill and agent invocations are " +
      "NOT redacted and are the reliable signal for which of your own plugins fire.",
  };
}

export function hookHealth(db: DatabaseSync, o: { since?: string | undefined; limit?: number | undefined } = {}) {
  const where = ["1=1"]; const params: unknown[] = [];
  if (o.since) { where.push("ts >= ?"); params.push(o.since); }
  const w = where.join(" AND ");
  const limit = o.limit ?? 25;
  const summary = all(db,
    `SELECT hook_name, hook_event, count(*) AS runs, sum(num_hooks) AS hooks_invoked,` +
    ` sum(num_success) AS succeeded, sum(num_errors) AS errored,` +
    ` sum(num_blocking) AS blocked, round(avg(duration_ms),1) AS avg_ms` +
    ` FROM hook_runs WHERE ${w} GROUP BY hook_name, hook_event` +
    ` ORDER BY errored DESC, runs DESC`, params, limit);
  const failing = summary.filter((r) => Number(r["errored"] ?? 0) > 0);
  const total = db.prepare(
    `SELECT count(*) AS runs, sum(num_errors) AS errs FROM hook_runs WHERE ${w}`,
  ).get(...params as never[]) as { runs: number; errs: number | null };
  let verdict = "no hook telemetry yet — hooks are only reported by OTel, so start the sink";
  if (total.runs) {
    verdict = !(total.errs ?? 0)
      ? "every hook run completed cleanly"
      : `${failing.length} hook(s) are erroring; the tool calls they guard proceeded anyway`;
  }
  return {
    verdict, runs: total.runs, totalErrors: total.errs ?? 0, failing, byHook: summary,
    note:
      "A non-blocking error means the guarded tool call still ran. Any non-zero " +
      "'errored' here is a guard that silently did not apply, not a cosmetic warning.",
  };
}

export function sql(db: DatabaseSync, o: { query?: string | undefined; limit?: number | undefined }) {
  const q = o.query ?? "";
  if (!SELECT_ONLY.test(q) || FORBIDDEN.test(q) || q.includes(";")) {
    throw new Error("only a single read-only SELECT is allowed");
  }
  return { rows: all(db, q, [], o.limit ?? 200) };
}
