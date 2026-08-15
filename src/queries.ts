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
};

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
  groupBy?: string | undefined; since?: string | undefined; until?: string | undefined; limit?: number | undefined;
} = {}) {
  const key = o.groupBy ?? "model";
  const col = COST_GROUPS[key];
  if (!col) throw new Error(`group_by must be one of: ${Object.keys(COST_GROUPS).sort().join(", ")}`);
  const where = ["1=1"]; const params: unknown[] = [];
  if (o.since) { where.push("ts >= ?"); params.push(o.since); }
  if (o.until) { where.push("ts <= ?"); params.push(o.until); }
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
} = {}) {
  const where = ["1=1"]; const params: unknown[] = [];
  if (o.since) { where.push("s.started_at >= ?"); params.push(o.since); }
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
  toolName?: string | undefined; success?: boolean | undefined; decision?: string | undefined; since?: string | undefined; limit?: number | undefined;
} = {}) {
  const where = ["1=1"]; const params: unknown[] = [];
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

export function trace(db: DatabaseSync, o: { traceId?: string | undefined; sessionId?: string | undefined }) {
  let traceId = o.traceId;
  if (!traceId) {
    if (!o.sessionId) throw new Error("pass traceId or sessionId");
    const r = db.prepare(
      "SELECT trace_id FROM spans WHERE session_id=? ORDER BY ts DESC LIMIT 1",
    ).get(o.sessionId) as { trace_id: string } | undefined;
    if (!r) {
      return {
        spans: [], note:
          "no spans for that session — traces are a beta exporter and off unless " +
          "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1",
      };
    }
    traceId = r.trace_id;
  }
  const spans = db.prepare(
    "SELECT span_id, parent_id, name, ts, duration_ms, attrs FROM spans" +
    " WHERE trace_id=? ORDER BY ts",
  ).all(traceId) as Array<Row & { span_id: string; parent_id: string | null; attrs: string }>;

  const byParent = new Map<string | null, typeof spans>();
  for (const s of spans) {
    const k = s.parent_id ?? null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(s);
  }
  const build = (pid: string | null): Row[] =>
    (byParent.get(pid) ?? []).map((s) => ({
      name: s["name"], duration_ms: s["duration_ms"], ts: s["ts"],
      attrs: JSON.parse(s.attrs) as Row, children: build(s.span_id),
    }));
  return { traceId, spanCount: spans.length, tree: build(null) };
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
