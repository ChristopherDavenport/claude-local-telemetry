/**
 * Local OTLP/HTTP-JSON receiver: Claude Code telemetry straight into SQLite.
 *
 * Point Claude Code at it:
 *
 *   CLAUDE_CODE_ENABLE_TELEMETRY=1
 *   CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1      # traces; beta, off by default
 *   OTEL_METRICS_EXPORTER=otlp
 *   OTEL_LOGS_EXPORTER=otlp
 *   OTEL_TRACES_EXPORTER=otlp
 *   OTEL_EXPORTER_OTLP_PROTOCOL=http/json      # no default — must be set
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
 *
 * `http/json` is the load-bearing setting: payloads arrive as plain JSON, so
 * this is `node:http` and nothing else. With grpc or http/protobuf it would
 * need a collector.
 *
 * Two things about the data that shape what is stored
 * ---------------------------------------------------
 * **Cost only exists here.** `claude_code.api_request` carries `cost_usd` and
 * the full cache split. Transcripts carry exact tokens but no cost.
 *
 * **Attribution is redacted.** `plugin.name`, `skill.name` and
 * `marketplace.name` report the literal string `third-party` for every
 * non-official plugin. `plugin_id_hash` on `plugin_loaded` is stable and
 * distinct, so it is kept as the join key and `plugin_alias` turns it back into
 * a name. Do not trust `api_requests.plugin_name` for private plugins.
 *
 * Binds to loopback only. Telemetry contains prompts and tool inputs when the
 * content flags are on, and this process does no authentication whatsoever.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { init } from "./store.ts";

type AnyValue = Record<string, unknown>;
type Attrs = Record<string, unknown>;

/** Unwrap an OTLP AnyValue. */
export function attrValue(v: AnyValue | undefined): unknown {
  if (v == null || typeof v !== "object") return v;
  if ("stringValue" in v) return v["stringValue"];
  if ("boolValue" in v) return v["boolValue"];
  if ("intValue" in v) { const n = Number(v["intValue"]); return Number.isNaN(n) ? v["intValue"] : n; }
  if ("doubleValue" in v) { const n = Number(v["doubleValue"]); return Number.isNaN(n) ? v["doubleValue"] : n; }
  if ("arrayValue" in v) {
    const a = v["arrayValue"] as { values?: AnyValue[] };
    return (a.values ?? []).map(attrValue);
  }
  if ("kvlistValue" in v) {
    const kv = v["kvlistValue"] as { values?: Array<{ key: string; value: AnyValue }> };
    return Object.fromEntries((kv.values ?? []).map((x) => [x.key, attrValue(x.value)]));
  }
  return null;
}

export function attrsOf(obj: { attributes?: Array<{ key: string; value?: AnyValue }> }): Attrs {
  const out: Attrs = {};
  for (const a of obj.attributes ?? []) out[a.key] = attrValue(a.value);
  return out;
}

export function iso(nano: unknown): string {
  const n = Number(nano);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n / 1e6).toISOString();
}

const int = (v: unknown): number | null => {
  const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null;
};
const flt = (v: unknown): number | null => {
  const n = Number(v); return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" ? v : v == null ? null : String(v));

/**
 * Deterministic JSON for the `attrs` columns.
 *
 * Deliberately not `JSON.stringify(a, Object.keys(a).sort())`. An array replacer
 * is applied recursively, so a nested object gets filtered by the *top-level*
 * key list and silently loses its contents — `{"a.b":{"inner":1},"z":3}`
 * serialises as `{"a.b":{},"z":3}`. Attribute values are usually scalars, but
 * OTLP `kvlistValue` nests, so the naive form would drop real data.
 *
 * Sorted because these strings participate in the events UNIQUE constraint;
 * unstable key order would defeat deduplication.
 */
function stableJson(a: Attrs): string {
  return JSON.stringify(Object.fromEntries(
    Object.keys(a).sort().map((k) => [k, a[k]]),
  ));
}

const UPSERT_API = `
INSERT INTO api_requests (
    request_id, ts, session_id, model, cost_usd,
    input_tokens, output_tokens, cache_read, cache_creation,
    duration_ms, query_source, speed, effort,
    agent_name, skill_name, plugin_name, marketplace_name, plugin_resolved,
    mcp_server, mcp_tool, cwd, git_branch, source, plugin_id_hash
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(request_id) DO UPDATE SET
    cost_usd       = COALESCE(excluded.cost_usd, api_requests.cost_usd),
    duration_ms    = COALESCE(excluded.duration_ms, api_requests.duration_ms),
    query_source   = COALESCE(excluded.query_source, api_requests.query_source),
    speed          = COALESCE(excluded.speed, api_requests.speed),
    effort         = COALESCE(excluded.effort, api_requests.effort),
    agent_name     = COALESCE(excluded.agent_name, api_requests.agent_name),
    skill_name     = COALESCE(excluded.skill_name, api_requests.skill_name),
    plugin_name    = COALESCE(excluded.plugin_name, api_requests.plugin_name),
    plugin_id_hash = COALESCE(api_requests.plugin_id_hash, excluded.plugin_id_hash),
    input_tokens   = COALESCE(api_requests.input_tokens, excluded.input_tokens),
    output_tokens  = COALESCE(api_requests.output_tokens, excluded.output_tokens),
    cache_read     = COALESCE(api_requests.cache_read, excluded.cache_read),
    cache_creation = COALESCE(api_requests.cache_creation, excluded.cache_creation),
    source         = CASE WHEN api_requests.source = excluded.source
                          THEN api_requests.source ELSE 'otel+transcript' END`;

const UPSERT_TOOL = `
INSERT INTO tool_calls
 (ts, session_id, tool_use_id, tool_name, success, duration_ms, decision,
  decision_source, error_type, input_bytes, result_bytes, mcp_scope, cwd, source)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(tool_use_id, source) DO UPDATE SET
    success         = COALESCE(excluded.success, tool_calls.success),
    duration_ms     = COALESCE(excluded.duration_ms, tool_calls.duration_ms),
    decision        = COALESCE(excluded.decision, tool_calls.decision),
    decision_source = COALESCE(excluded.decision_source, tool_calls.decision_source),
    error_type      = COALESCE(excluded.error_type, tool_calls.error_type),
    input_bytes     = COALESCE(excluded.input_bytes, tool_calls.input_bytes),
    result_bytes    = COALESCE(excluded.result_bytes, tool_calls.result_bytes)`;

/**
 * Real plugin name, if we can get one.
 *
 * OTel gives `third-party` for anything not in the official marketplace, so a
 * literal match on that string is worthless. Fall back to the alias table keyed
 * on plugin_id_hash when one is present.
 */
function resolvePlugin(db: DatabaseSync, a: Attrs): string | null {
  const name = a["plugin.name"];
  if (typeof name === "string" && name !== "third-party") return name;
  const h = a["plugin_id_hash"];
  if (typeof h === "string") {
    const row = db.prepare("SELECT plugin_name FROM plugin_alias WHERE plugin_id_hash=?")
      .get(h) as { plugin_name: string } | undefined;
    if (row) return row.plugin_name;
  }
  return null;
}

export function handleLogs(db: DatabaseSync, payload: Record<string, unknown>): number {
  let n = 0;
  const upsertApi = db.prepare(UPSERT_API);
  const upsertTool = db.prepare(UPSERT_TOOL);
  const insHook = db.prepare(
    "INSERT OR IGNORE INTO hook_runs (ts, session_id, prompt_id, hook_event, hook_name," +
    " hook_source, num_hooks, num_success, num_blocking, num_errors, num_cancelled," +
    " duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const insPlugin = db.prepare(
    "INSERT OR IGNORE INTO plugin_loads (ts, session_id, plugin_id_hash, plugin_name," +
    " marketplace, scope, version, skill_count, agent_count, command_count, has_hooks," +
    " has_mcp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const insEvent = db.prepare(
    "INSERT OR IGNORE INTO events (ts, session_id, name, attrs, source) VALUES (?,?,?,?,?)");
  const upsertSession = db.prepare(
    "INSERT INTO sessions (session_id, started_at, ended_at, cwd, git_branch, entrypoint," +
    " app_version, source) VALUES (?,?,?,?,?,?,?,?)" +
    " ON CONFLICT(session_id) DO UPDATE SET" +
    "  started_at = MIN(sessions.started_at, excluded.started_at)," +
    "  ended_at   = MAX(sessions.ended_at, excluded.ended_at)");

  for (const rl of (payload["resourceLogs"] as Array<Record<string, unknown>>) ?? []) {
    for (const sl of (rl["scopeLogs"] as Array<Record<string, unknown>>) ?? []) {
      for (const rec of (sl["logRecords"] as Array<Record<string, unknown>>) ?? []) {
        const a = attrsOf(rec as never);
        const name = str(a["event.name"]) ?? "unknown";
        const ts = str(a["event.timestamp"]) ?? iso(rec["timeUnixNano"]);
        const sid = str(a["session.id"]);
        n++;

        if (name === "api_request") {
          upsertApi.run(
            str(a["request_id"]) ?? `otel:${ts}:${String(a["event.sequence"] ?? "")}`,
            ts, sid, str(a["model"]), flt(a["cost_usd"]),
            int(a["input_tokens"]), int(a["output_tokens"]),
            int(a["cache_read_tokens"]), int(a["cache_creation_tokens"]),
            int(a["duration_ms"]), str(a["query_source"]), str(a["speed"]), str(a["effort"]),
            str(a["agent.name"]), str(a["skill.name"]), str(a["plugin.name"]),
            str(a["marketplace.name"]), resolvePlugin(db, a),
            str(a["mcp_server.name"]), str(a["mcp_tool.name"]),
            null, null, "otel", str(a["plugin_id_hash"]));
        } else if (name === "tool_result" || name === "tool_decision") {
          const tid = str(a["tool_use_id"]);
          if (tid) {
            const succ = a["success"] === undefined ? null
              : (String(a["success"]).toLowerCase() === "true" ? 1 : 0);
            upsertTool.run(ts, sid, tid, str(a["tool_name"]), succ, int(a["duration_ms"]),
              str(a["decision"]), str(a["source"] ?? a["decision_source"]),
              str(a["error_type"]), int(a["tool_input_size_bytes"]),
              int(a["tool_result_size_bytes"]), str(a["mcp_server_scope"]), null, "otel");
          }
        } else if (name === "hook_execution_complete") {
          // num_non_blocking_error is the reason this gets a table. A hook
          // erroring on every call is invisible in a session: the contract says
          // the tool proceeds anyway.
          insHook.run(ts, sid, str(a["prompt.id"]), str(a["hook_event"]),
            str(a["hook_name"]), str(a["hook_source"]), int(a["num_hooks"]),
            int(a["num_success"]), int(a["num_blocking"]),
            int(a["num_non_blocking_error"]), int(a["num_cancelled"]),
            int(a["total_duration_ms"]));
        } else if (name === "plugin_loaded") {
          insPlugin.run(ts, sid, str(a["plugin_id_hash"]), str(a["plugin.name"]),
            str(a["marketplace.name"]), str(a["plugin.scope"]), str(a["plugin.version"]),
            int(a["skill_path_count"]), int(a["agent_path_count"]),
            int(a["command_path_count"]),
            a["has_hooks"] === true || a["has_hooks"] === "true" ? 1 : 0,
            a["has_mcp"] === true || a["has_mcp"] === "true" ? 1 : 0);
        }

        // Everything lands in events too, including the cases above: the typed
        // tables are projections, and a future CLI release adding an attribute
        // should not lose it.
        insEvent.run(ts, sid, name,
          stableJson(a), "otel");

        if (sid) {
          upsertSession.run(sid, ts, ts, null, null,
            str(a["app.entrypoint"]), str(a["app.version"]), "otel");
        }
      }
    }
  }
  return n;
}

export function handleMetrics(db: DatabaseSync, payload: Record<string, unknown>): number {
  let n = 0;
  const ins = db.prepare("INSERT INTO metrics (ts, name, value, attrs) VALUES (?,?,?,?)");
  for (const rm of (payload["resourceMetrics"] as Array<Record<string, unknown>>) ?? []) {
    for (const sm of (rm["scopeMetrics"] as Array<Record<string, unknown>>) ?? []) {
      for (const m of (sm["metrics"] as Array<Record<string, unknown>>) ?? []) {
        const body = (m["sum"] ?? m["gauge"] ?? m["histogram"] ?? {}) as Record<string, unknown>;
        for (const p of (body["dataPoints"] as Array<Record<string, unknown>>) ?? []) {
          const a = attrsOf(p as never);
          const val = p["asDouble"] ?? p["asInt"] ?? p["sum"];
          ins.run(iso(p["timeUnixNano"] ?? p["startTimeUnixNano"]),
            str(m["name"]) ?? "unknown", flt(val),
            stableJson(a));
          n++;
        }
      }
    }
  }
  return n;
}

export function handleTraces(db: DatabaseSync, payload: Record<string, unknown>): number {
  let n = 0;
  const ins = db.prepare(
    "INSERT OR IGNORE INTO spans (span_id, trace_id, parent_id, name, ts, duration_ms," +
    " session_id, attrs) VALUES (?,?,?,?,?,?,?,?)");
  for (const rs of (payload["resourceSpans"] as Array<Record<string, unknown>>) ?? []) {
    for (const ss of (rs["scopeSpans"] as Array<Record<string, unknown>>) ?? []) {
      for (const sp of (ss["spans"] as Array<Record<string, unknown>>) ?? []) {
        const a = attrsOf(sp as never);
        const start = Number(sp["startTimeUnixNano"]);
        const end = Number(sp["endTimeUnixNano"]);
        const dur = Number.isFinite(start) && Number.isFinite(end) ? (end - start) / 1e6 : null;
        ins.run(str(sp["spanId"]), str(sp["traceId"]) ?? "", str(sp["parentSpanId"]) || null,
          str(sp["name"]) ?? "unknown", iso(sp["startTimeUnixNano"]), dur,
          str(a["session.id"]), stableJson(a));
        n++;
      }
    }
  }
  return n;
}

const HANDLERS: Record<string, (db: DatabaseSync, p: Record<string, unknown>) => number> = {
  metrics: handleMetrics, logs: handleLogs, traces: handleTraces,
};

export interface SinkOptions {
  host?: string | undefined; port?: number | undefined; db?: string | undefined; verbose?: boolean | undefined;
}

export function startSink(opts: SinkOptions = {}) {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4318;
  const db = init(opts.db);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const signal = (req.url ?? "").split("/").pop() ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let raw = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") {
        try { raw = gunzipSync(raw); } catch { /* not actually gzipped */ }
      }
      let written = 0;
      try {
        // Claude Code opens with a 2-byte probe sent as x-www-form-urlencoded;
        // treat anything unparseable as a no-op rather than a failure, or the
        // exporter backs off.
        const text = raw.toString("utf8").trim();
        const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
        const fn = HANDLERS[signal];
        if (fn && Object.keys(payload).length) written = fn(db, payload);
      } catch (err) {
        if (opts.verbose) process.stderr.write(`  ! ${signal}: ${(err as Error).message}\n`);
      }
      if (opts.verbose && written) {
        process.stdout.write(`  ${signal.padEnd(8)} ${String(written).padStart(4)} rows  (${raw.length}B)\n`);
      }
      const body = "{}";
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) });
      res.end(body);
    });
  });

  server.listen(port, host, () => {
    process.stdout.write(`listening on http://${host}:${port}  ->  ${opts.db ?? "default db"}\n`);
    process.stdout.write("  POST /v1/metrics  /v1/logs  /v1/traces\n");
  });
  return { server, db };
}
