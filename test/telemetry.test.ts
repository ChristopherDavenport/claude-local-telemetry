/**
 * Assertion tests for the store, backfill, OTel path and query surface.
 *
 * Synthetic fixtures throughout, deliberately: real transcripts carry prompts
 * and absolute paths that should not be in a repo, they differ per machine so
 * results would not be reproducible, and they do not reliably contain the edge
 * cases worth pinning — an all-zero usage record, a tool call with no result, a
 * repeated requestId, a hook run that errors.
 *
 * No model, no network, no dependency on a real ~/.claude/projects.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { init, openForRead, stats, TABLES, SCHEMA_VERSION } from "../src/store.ts";
import { backfill, pathContext } from "../src/backfill.ts";
import { handleLogs, handleTraces } from "../src/sink.ts";
import * as Q from "../src/queries.ts";
import { dispatch, TOOLS } from "../src/mcp.ts";
import * as Alias from "../src/alias.ts";

let work: string;
let db: string;
let root: string;

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ts = (i: number) => `2026-08-15T12:00:0${i}.000Z`;

function rec(o: Record<string, unknown>) {
  return JSON.stringify({
    sessionId: SID, cwd: "/tmp/demo", gitBranch: "main",
    version: "2.1.233", isSidechain: false, ...o,
  });
}
const usage = (i = 10, o = 20, cr = 0, cc = 0) => ({
  input_tokens: i, output_tokens: o,
  cache_read_input_tokens: cr, cache_creation_input_tokens: cc,
});
const assistant = (i: number, rid: string, u: object, content: unknown[] = []) =>
  rec({ type: "assistant", uuid: `a${i}`, timestamp: ts(i), requestId: rid,
        message: { id: `msg_${i}`, model: "claude-opus-5", role: "assistant", usage: u, content } });

before(() => {
  work = mkdtempSync(join(tmpdir(), "claude-local-telemetry-test-"));
  db = join(work, "t.db");
  root = join(work, "projects", "-tmp-demo");
  mkdirSync(root, { recursive: true });

  writeFileSync(join(root, "s1.jsonl"), [
    assistant(0, "req_a", usage(100, 50, 0, 200)),
    // Same requestId twice with identical usage: must collapse to one row.
    assistant(1, "req_dup", usage(5, 5)),
    assistant(2, "req_dup", usage(5, 5)),
    // All-zero usage is not an accounting; must be skipped entirely.
    assistant(3, "req_zero", usage(0, 0, 0, 0)),
    // A tool call that completes.
    assistant(4, "req_tool", usage(7, 7),
      [{ type: "tool_use", id: "toolu_ok", name: "Bash", input: { command: "echo hi" } }]),
    rec({ type: "user", uuid: "u4", timestamp: ts(5), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_ok", content: "hi", is_error: false }] } }),
    // A tool call that errors.
    assistant(6, "req_err", usage(3, 3),
      [{ type: "tool_use", id: "toolu_err", name: "Read", input: { file_path: "/nope" } }]),
    rec({ type: "user", uuid: "u6", timestamp: ts(7), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_err", content: "ENOENT", is_error: true }] } }),
    // A tool call with no result: the session ended mid-flight.
    assistant(8, "req_orphan", usage(2, 2),
      [{ type: "tool_use", id: "toolu_orphan", name: "Bash", input: { command: "sleep 999" } }]),
    // Skill/Agent: the un-redacted attribution OTel will not give us.
    assistant(9, "req_skill", usage(4, 4), [
      { type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "demo-skill" } },
      { type: "tool_use", id: "toolu_agent", name: "Agent", input: { subagent_type: "demo-agent" } }]),
  ].join("\n") + "\n");

  init(db).close();
});

after(() => rmSync(work, { recursive: true, force: true }));

const q = <T>(fn: (d: ReturnType<typeof openForRead>) => T): T => {
  const d = openForRead(db);
  try { return fn(d); } finally { d.close(); }
};
const scalar = (sql: string): number =>
  q((d) => (d.prepare(sql).get() as Record<string, number>)["c"] ?? 0);

test("schema creates every table, STRICT, in WAL", () => {
  const d = init(db);
  const names = new Set((d.prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>).map((r) => r.name));
  for (const t of TABLES) assert.ok(names.has(t), `missing table ${t}`);
  const mode = d.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(mode.journal_mode, "wal");
  const nonStrict = d.prepare(
    "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'" +
    " AND sql NOT LIKE '%STRICT%'").get() as { c: number };
  assert.equal(nonStrict.c, 0, "every table should be STRICT");
  d.close();
});

test("backfill imports a transcript", () => {
  const r = backfill({ root: join(work, "projects"), db, quiet: true });
  assert.equal(r.files, 1);
  assert.ok(r.api > 0);
  assert.ok(scalar("SELECT count(*) c FROM api_requests") > 0);
});

test("backfill is idempotent", () => {
  const snap = () => TABLES.map((t) => scalar(`SELECT count(*) c FROM ${t}`)).join("|");
  const a = snap();
  backfill({ root: join(work, "projects"), db, quiet: true });
  const b = snap();
  backfill({ root: join(work, "projects"), db, quiet: true });
  assert.equal(a, b, "second import changed row counts");
  assert.equal(b, snap(), "third import changed row counts");
});

test("a repeated requestId collapses to one row", () => {
  assert.equal(scalar("SELECT count(*) c FROM api_requests WHERE request_id='req_dup'"), 1);
});

test("all-zero usage records are skipped", () => {
  assert.equal(scalar("SELECT count(*) c FROM api_requests WHERE request_id='req_zero'"), 0);
});

test("unanswered tool calls are recorded, not dropped", () => {
  // Three in the fixture, not one: toolu_orphan has no result by design, and the
  // Skill and Agent blocks have none either — which is how those actually appear
  // when a transcript ends before the sub-agent returns. Asserting the specific
  // id as well as the count, so a change in orphan handling cannot pass by
  // coincidentally still totalling three.
  assert.equal(scalar("SELECT count(*) c FROM tool_calls WHERE error_type='no_result'"), 3);
  assert.equal(scalar(
    "SELECT count(*) c FROM tool_calls WHERE tool_use_id='toolu_orphan' AND error_type='no_result'"), 1);
});

test("failed tool calls keep their error", () => {
  assert.equal(scalar("SELECT count(*) c FROM tool_calls WHERE success=0"), 1);
});

test("un-redacted skill and agent invocations are captured", () => {
  assert.equal(scalar("SELECT count(*) c FROM events WHERE name LIKE 'transcript.%_invoked'"), 2);
});

// Cost, permission decisions and hook outcomes exist only in OTel; a transcript
// never carries them, so the fixture above cannot reach this code at all.
test("sink ingests OTLP logs: cost, decisions, hooks, redaction", () => {
  const kv = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => ({
    key: k,
    value: typeof v === "boolean" ? { boolValue: v }
      : typeof v === "number" ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
      : { stringValue: String(v) },
  }));
  const ev = (name: string, t: string, attrs: Record<string, unknown>) => ({
    timeUnixNano: "1755280000000000000",
    attributes: kv({ "session.id": SID, "event.name": name, "event.timestamp": t, ...attrs }),
  });

  const d = init(db);
  handleLogs(d, { resourceLogs: [{ scopeLogs: [{ logRecords: [
    ev("api_request", ts(0), { model: "claude-opus-5", cost_usd: 0.0421, input_tokens: 12,
      output_tokens: 340, cache_read_tokens: 51000, cache_creation_tokens: 1200,
      duration_ms: 2100, request_id: "req_otel_1", query_source: "main" }),
    ev("tool_decision", ts(1), { tool_name: "Bash", tool_use_id: "toolu_otel_1",
      decision: "accept", source: "config" }),
    ev("hook_execution_complete", ts(3), { hook_event: "PreToolUse",
      hook_name: "PreToolUse:Read", num_hooks: 1, num_success: 1, num_blocking: 0,
      num_non_blocking_error: 0, total_duration_ms: 12 }),
    // THE case: a hook erroring. The guarded call proceeded anyway.
    ev("hook_execution_complete", ts(4), { hook_event: "PreToolUse",
      hook_name: "PreToolUse:Bash", num_hooks: 2, num_success: 1, num_blocking: 0,
      num_non_blocking_error: 1, total_duration_ms: 80 }),
    ev("hook_execution_complete", ts(5), { hook_event: "Stop", hook_name: "Stop",
      num_hooks: 1, num_success: 0, num_blocking: 0, num_non_blocking_error: 1,
      total_duration_ms: 25 }),
    ev("plugin_loaded", ts(6), { "plugin.name": "third-party",
      "marketplace.name": "third-party", plugin_id_hash: "deadbeefcafe0001",
      skill_path_count: 1, agent_path_count: 0 }),
  ] }] }] });
  d.close();

  const cost = q((c) => (c.prepare(
    "SELECT cost_usd FROM api_requests WHERE request_id='req_otel_1'").get() as { cost_usd: number }));
  assert.equal(cost.cost_usd, 0.0421, "cost_usd must survive the OTel path");
  const dec = q((c) => c.prepare(
    "SELECT decision, decision_source FROM tool_calls WHERE tool_use_id='toolu_otel_1'")
    .get() as { decision: string; decision_source: string });
  assert.deepEqual([dec.decision, dec.decision_source], ["accept", "config"]);
  assert.equal(scalar("SELECT count(*) c FROM hook_runs WHERE num_errors > 0"), 2);
  assert.equal(scalar("SELECT count(*) c FROM plugin_loads WHERE plugin_name='third-party'"), 1);
});

test("hook_health surfaces failing hooks", () => {
  const h = q((d) => Q.hookHealth(d));
  assert.equal(h.totalErrors, 2);
  assert.equal(h.failing.length, 2);
  assert.match(h.verdict, /erroring/);
});

test("nested OTLP attribute values survive serialisation", () => {
  // A naive JSON.stringify(a, Object.keys(a).sort()) filters nested objects by
  // the top-level key list and silently empties them.
  const d = init(db);
  handleLogs(d, { resourceLogs: [{ scopeLogs: [{ logRecords: [{
    timeUnixNano: "1755280000000000000",
    attributes: [
      { key: "event.name", value: { stringValue: "nested_probe" } },
      { key: "event.timestamp", value: { stringValue: ts(9) } },
      { key: "payload", value: { kvlistValue: { values: [
        { key: "inner", value: { stringValue: "kept" } }] } } },
    ],
  }] }] }] });
  d.close();
  const row = q((c) => c.prepare(
    "SELECT attrs FROM events WHERE name='nested_probe'").get() as { attrs: string });
  assert.match(row.attrs, /"inner":"kept"/);
});

test("every query returns and stays a reasonable size", () => {
  q((d) => {
    for (const [name, fn] of Object.entries({
      overview: () => Q.overview(d),
      cost: () => Q.cost(d, { groupBy: "model" }),
      sessions: () => Q.sessions(d),
      toolAudit: () => Q.toolAudit(d),
      runQuery: () => Q.runQuery(d, { calculate: "sum_input", breakdown: "model" }),
      pluginCosts: () => Q.pluginCosts(d),
      hookHealth: () => Q.hookHealth(d),
      traces: () => Q.traces(d),
      workflows: () => Q.workflows(d),
      agents: () => Q.agents(d),
      teams: () => Q.teams(d),
    })) {
      const size = JSON.stringify(fn()).length;
      assert.ok(size > 0, `${name} returned nothing`);
      assert.ok(size < 20000, `${name} default payload is ${size}B — too large for one call`);
    }
  });
});

/**
 * The vocabularies are hand-maintained lists that have to track the schema, and
 * schema v2 shipped with three new columns that `cost()` could not group by —
 * so "what did each agent cost", the first question the new data invites, only
 * worked through run_query. These execute every advertised option against a
 * real store, so an option that names a column which does not exist fails here
 * rather than in someone's tool call.
 */
test("every advertised group_by and table actually runs", () => {
  q((d) => {
    for (const g of Object.keys(Q.COST_GROUPS_FOR_TEST)) {
      assert.doesNotThrow(() => Q.cost(d, { groupBy: g, limit: 1 }), `group_by ${g}`);
    }
    for (const t of TABLES) {
      assert.doesNotThrow(() => Q.runQuery(d, { table: t, calculate: "count", limit: 1 }), `table ${t}`);
    }
  });
});

test("the v2 columns are reachable from the purpose-built tools", () => {
  for (const g of ["agent_id", "workflow_run_id", "plugin_id_hash"]) {
    assert.ok(g in Q.COST_GROUPS_FOR_TEST, `cost() cannot group by ${g}`);
  }
});

test("the read-only guard refuses everything that is not a SELECT", () => {
  q((d) => {
    for (const bad of [
      "DELETE FROM api_requests", "SELECT 1; DROP TABLE events",
      "INSERT INTO events VALUES(1,'a','b','c','d','e')",
      "UPDATE api_requests SET cost_usd=0", "PRAGMA table_info(events)",
      "ATTACH DATABASE '/tmp/x' AS x",
    ]) {
      assert.throws(() => Q.sql(d, { query: bad }), /read-only SELECT/, `let through: ${bad}`);
    }
    assert.ok(Q.sql(d, { query: "SELECT 1 AS ok" }).rows.length === 1);
  });
});

test("MCP handshake, tools/list and a tool call", () => {
  const init_ = dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, db);
  assert.equal((init_?.["result"] as Record<string, Record<string, string>>)["serverInfo"]!["name"],
    "claude-local-telemetry");
  const list = dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" }, db);
  const tools = (list?.["result"] as { tools: unknown[] }).tools;
  assert.equal(tools.length, TOOLS.length);
  assert.ok(TOOLS.length >= 9);
  const call = dispatch({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "telemetry_overview", arguments: {} } }, db);
  assert.ok(!(call?.["result"] as Record<string, unknown>)["isError"]);
  const bad = dispatch({ jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "nope", arguments: {} } }, db);
  assert.ok(bad?.["error"], "unknown tool should error");
});

test("a store from an older version reports how to migrate", () => {
  const stale = join(work, "stale.db");
  const d = init(stale);
  d.exec("DROP TABLE hook_runs");
  d.close();
  assert.throws(() => openForRead(stale), /predates this version.*hook_runs/s);
});

test("stats reports source breakdown so the cost gap is visible", () => {
  const s = q((d) => stats(d));
  assert.ok(Object.keys(s.bySource).length > 0);
  assert.ok(s.rows["api_requests"]! > 0);
});

/* ------------------------------------------------------------------ *
 * Agents, workflows and aliases.
 * ------------------------------------------------------------------ */

test("a transcript's path says which agent and workflow wrote it", () => {
  const root = "/r";
  assert.deepEqual(pathContext("/r/proj/sess.jsonl", root), {
    kind: "main", parentSessionId: null, agentId: null, workflowRunId: null,
  });
  assert.deepEqual(pathContext("/r/proj/PARENT/subagents/agent-abc123.jsonl", root), {
    kind: "agent", parentSessionId: "PARENT", agentId: "abc123", workflowRunId: null,
  });
  assert.deepEqual(
    pathContext("/r/proj/PARENT/subagents/workflows/wf_9/agent-abc123.jsonl", root),
    { kind: "agent", parentSessionId: "PARENT", agentId: "abc123", workflowRunId: "wf_9" },
  );
});

/** A tiny project tree: one main session, one plain agent, one workflow agent. */
function agentCorpus(): { root: string; db: string } {
  const base = join(work, "agents");
  const proj = join(base, "proj");
  const PAR = "11111111-2222-3333-4444-555555555555";
  mkdirSync(join(proj, PAR, "subagents", "workflows", "wf_test"), { recursive: true });

  const turn = (sid: string, rid: string, extra: Record<string, unknown> = {}) => rec({
    type: "assistant", uuid: `u-${rid}`, timestamp: ts(1), sessionId: sid, requestId: rid,
    message: { role: "assistant", model: "m", usage: usage(10, 5), content: [] },
    ...extra,
  });

  // Main session: a plain turn, plus one attributed to a plugin by the transcript.
  writeFileSync(join(proj, `${PAR}.jsonl`), [
    turn(PAR, "req_main"),
    turn(PAR, "req_plugin", { attributionPlugin: "my-plugin", attributionSkill: "my-skill" }),
  ].join("\n") + "\n");

  // Both agents report the *parent's* sessionId, as real ones do.
  writeFileSync(join(proj, PAR, "subagents", "agent-aworker-99.jsonl"),
    turn(PAR, "req_agent") + "\n");
  writeFileSync(join(proj, PAR, "subagents", "workflows", "wf_test", "agent-awf-1.jsonl"),
    turn(PAR, "req_wf") + "\n");

  const dbPath = join(base, "agents.db");
  backfill({ root: base, db: dbPath, quiet: true });
  return { root: base, db: dbPath };
}

test("subagent turns are tagged with their agent and workflow, not split into sessions", () => {
  const { db: path } = agentCorpus();
  const d = openForRead(path);
  // Spread into a plain object: node:sqlite hands back null-prototype rows and
  // deepEqual compares prototypes.
  const row = (rid: string) => ({ ...d.prepare(
    "SELECT session_id, query_source, agent_id, workflow_run_id FROM api_requests WHERE request_id=?",
  ).get(rid) as Record<string, unknown> });

  assert.deepEqual(row("req_main"),
    { session_id: "11111111-2222-3333-4444-555555555555", query_source: "main",
      agent_id: null, workflow_run_id: null });
  assert.deepEqual(row("req_agent"),
    { session_id: "11111111-2222-3333-4444-555555555555", query_source: "subagent",
      agent_id: "aworker-99", workflow_run_id: null });
  assert.deepEqual(row("req_wf"),
    { session_id: "11111111-2222-3333-4444-555555555555", query_source: "subagent",
      agent_id: "awf-1", workflow_run_id: "wf_test" });

  // One session, not three: the agents share their parent's id.
  const n = d.prepare("SELECT count(*) c FROM sessions").get() as { c: number };
  assert.equal(n.c, 1, "an agent is not a session");
  d.close();
});

test("transcripts supply the attribution OTel redacts", () => {
  const { db: path } = agentCorpus();
  const d = openForRead(path);
  const r = d.prepare(
    "SELECT plugin_resolved, skill_name FROM api_requests WHERE request_id='req_plugin'",
  ).get() as Record<string, unknown>;
  assert.equal(r["plugin_resolved"], "my-plugin");
  assert.equal(r["skill_name"], "my-skill");
  d.close();
});

test("aliases are derived from requests both sources described", () => {
  const path = join(work, "alias.db");
  const d = init(path);
  // OTel saw a hash and the redacted name; a transcript named the same request.
  d.prepare(
    "INSERT INTO api_requests (request_id, ts, source, plugin_name, plugin_id_hash)" +
    " VALUES ('r1', ?, 'otel', 'third-party', 'HASH_A')").run(ts(1));
  d.prepare("UPDATE api_requests SET plugin_resolved='real-plugin' WHERE request_id='r1'").run();
  // A second request with the same hash but no name yet: this is what gets fixed.
  d.prepare(
    "INSERT INTO api_requests (request_id, ts, source, plugin_name, plugin_id_hash)" +
    " VALUES ('r2', ?, 'otel', 'third-party', 'HASH_A')").run(ts(2));
  // A hash the two sources disagree about must not be guessed at.
  for (const [rid, name] of [["r3", "one"], ["r4", "two"]]) {
    d.prepare(
      "INSERT INTO api_requests (request_id, ts, source, plugin_id_hash, plugin_resolved)" +
      " VALUES (?, ?, 'otel', 'HASH_B', ?)").run(rid!, ts(3), name!);
  }

  const out = Alias.derive(d, ts(4));
  assert.equal(out.learned, 1);
  assert.deepEqual(out.ambiguous, [{ plugin_id_hash: "HASH_B", names: ["one", "two"] }]);

  assert.equal(Alias.apply(d), 1, "the blinded request gains the name");
  const r2 = d.prepare("SELECT plugin_resolved FROM api_requests WHERE request_id='r2'")
    .get() as { plugin_resolved: string };
  assert.equal(r2.plugin_resolved, "real-plugin");

  // A hand-written mapping outranks a derived one and survives re-derivation.
  Alias.set(d, { hash: "HASH_B", name: "settled" });
  Alias.derive(d, ts(5));
  const b = Alias.list(d).find((a) => a.plugin_id_hash === "HASH_B");
  assert.equal(b?.plugin_name, "settled");
  assert.equal(b?.confidence, "manual");
  d.close();
});

test("an older store gains the newer columns without losing rows", () => {
  const path = join(work, "v1.db");
  const d = init(path);
  d.exec("INSERT INTO api_requests (request_id, ts, source) VALUES ('keep', '2026-01-01T00:00:00Z', 'otel')");
  // Simulate v1: drop the added columns' knowledge by rewinding the version.
  d.prepare("UPDATE meta SET value='1' WHERE key='schema_version'").run();
  d.close();

  // Not a hard-coded version: this assertion is about the shape of the
  // refusal, and pinning the number means every schema bump breaks a test that
  // has nothing to do with the change.
  assert.throws(
    () => openForRead(path),
    new RegExp(`schema v1.*needs v${SCHEMA_VERSION}`, "s"),
  );
  init(path).close();
  const re = openForRead(path);
  const r = re.prepare("SELECT count(*) c FROM api_requests WHERE request_id='keep'")
    .get() as { c: number };
  assert.equal(r.c, 1, "migration preserved existing rows");
  re.close();
});

/* ------------------------------------------------------------------ *
 * Traces.
 *
 * Its own store, because event placement is asserted by position and the
 * shared fixture's events would move the answers.
 * ------------------------------------------------------------------ */

const TSID = "trace-session";
const NS = 1_755_280_000_000_000_000; // base instant, nanoseconds
const at = (secs: number) => String(NS + secs * 1_000_000_000);

function traceStore(): string {
  const path = join(work, "trace.db");
  const d = init(path);
  const span = (id: string, parent: string | null, name: string, from: number, to: number) => ({
    traceId: "trace-1", spanId: id, ...(parent ? { parentSpanId: parent } : {}),
    name, startTimeUnixNano: at(from), endTimeUnixNano: at(to),
    attributes: [{ key: "session.id", value: { stringValue: TSID } }],
  });
  handleTraces(d, { resourceSpans: [{ scopeSpans: [{ spans: [
    span("a", null, "root.a", 0, 3),
    span("b", "a", "child.b", 1, 2),
    span("c", null, "root.c", 6, 8),
  ] }] }] });

  const ev = (name: string, secs: number) => ({
    timeUnixNano: at(secs),
    attributes: [
      { key: "event.name", value: { stringValue: name } },
      { key: "session.id", value: { stringValue: TSID } },
    ],
  });
  handleLogs(d, { resourceLogs: [{ scopeLogs: [{ logRecords: [
    ev("in_child", 1.5),   // narrowest cover is b
    ev("in_root", 2.5),    // only a covers it
    ev("in_gap", 4),       // inside the trace window, inside no span
    ev("way_after", 30),   // outside the window entirely
  ] }] }] });
  d.close();
  return path;
}

test("the trace tree nests spans and places events in the narrowest one", () => {
  const path = traceStore();
  const d = openForRead(path);
  const t = Q.trace(d, { traceId: "trace-1" });
  d.close();

  assert.equal(t.spanCount, 3);
  const roots = t.tree;
  // Two root spans plus the gap event, ordered by time.
  assert.deepEqual(roots.map((n) => n.name), ["root.a", "in_gap", "root.c"]);
  assert.equal(roots[1]!.kind, "event", "an event covered by no span stays at the top level");

  const a = roots[0]!;
  assert.equal(a.kind, "span");
  assert.equal(a.kind === "span" && a.span_id, "a");
  assert.equal(a.kind === "span" && a.parent_id, null);
  // child.b at 1s sorts before in_root at 2.5s.
  assert.deepEqual(a.children.map((n) => n.name), ["child.b", "in_root"]);

  const b = a.children[0]!;
  assert.equal(b.kind === "span" && b.parent_id, "a", "parent_id is exposed, not just implied");
  assert.deepEqual(b.children.map((n) => n.name), ["in_child"],
    "the event lands in the narrowest covering span, not the outermost");

  // Bounded to the trace's own window.
  assert.equal(t.eventCount, 3);
  assert.ok(!JSON.stringify(t.tree).includes("way_after"));
});

test("a session with no spans still returns an event tree", () => {
  const path = traceStore();
  const d = openForRead(path);
  const t = Q.trace(d, { sessionId: "no-such-session" });
  const own = Q.trace(d, { sessionId: TSID });
  d.close();

  assert.equal(t.spanCount, 0);
  assert.equal(t.tree.length, 0);
  assert.match(t.note ?? "", /beta exporter/);

  // The real session resolves to its trace and keeps the spans.
  assert.equal(own.traceId, "trace-1");
  assert.equal(own.spanCount, 3);
});

test("events are omitted when asked", () => {
  const path = traceStore();
  const d = openForRead(path);
  const t = Q.trace(d, { traceId: "trace-1", includeEvents: false });
  d.close();
  assert.equal(t.eventCount, 0);
  assert.deepEqual(t.tree.map((n) => n.name), ["root.a", "root.c"]);
});

test("the traces index lists roots, newest first", () => {
  const path = traceStore();
  const d = openForRead(path);
  const list = Q.traces(d);
  const empty = Q.traces(d, { sessionId: "nobody" });
  d.close();

  assert.equal(list.rows.length, 1);
  const row = list.rows[0] as Record<string, unknown>;
  assert.equal(row["trace_id"], "trace-1");
  assert.equal(row["span_count"], 3);
  assert.equal(row["session_id"], TSID);
  // Root name and duration come from a root span, not from max(duration).
  assert.ok(["root.a", "root.c"].includes(row["root_name"] as string));
  assert.equal(row["duration_ms"], 3000);

  assert.equal(empty.rows.length, 0);
  assert.match(empty.note ?? "", /only from the OTLP sink/);
});

test("a workflow manifest supplies the label and model its agents ran under", () => {
  // The gap this closes: a workflow agent is spawned by the runtime, so the
  // parent transcript has no Agent tool call describing it. Before v4 the only
  // trace was an api_requests row with an opaque agent_id -- cost with no task
  // attached, which was 94% of subagent spend on the machine this was written
  // for. The runtime writes the label to the run manifest; nothing read it.
  const root = join(work, "wf-root");
  const sess = join(root, "-proj", "sess-1");
  mkdirSync(join(sess, "workflows"), { recursive: true });
  writeFileSync(join(sess, "workflows", "wf_abc123.json"), JSON.stringify({
    runId: "wf_abc123",
    timestamp: "2026-08-01T00:00:00Z",
    workflowName: "demo",
    summary: "a demo run",
    scriptPath: "/tmp/demo.js",
    defaultModel: "claude-opus-5[1m]",
    status: "completed",
    agentCount: 2,
    totalTokens: 1234,
    totalToolCalls: 7,
    durationMs: 60000,
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "Survey" },
      {
        type: "workflow_agent", index: 1, label: "ground:api", phaseIndex: 1,
        phaseTitle: "Survey", agentId: "ag-1", model: "claude-sonnet-5",
        state: "done", queuedAt: 1000, startedAt: 3500, attempt: 1,
        tokens: 900, toolCalls: 4, durationMs: 5000,
        promptPreview: "survey the API", resultPreview: "{...}",
      },
      {
        type: "workflow_agent", index: 2, label: "impl:T1", phaseIndex: 1,
        phaseTitle: "Survey", agentId: "ag-2", model: "claude-opus-5",
        state: "done", attempt: 2, tokens: 100, toolCalls: 1,
      },
    ],
  }));

  const dbPath = join(work, "wf.db");
  backfill({ root, db: dbPath, quiet: true });
  const d = openForRead(dbPath);

  const rows = d.prepare(
    "SELECT agent_id, label, model, phase, attempt, queued_ms, workflow_run_id," +
    " total_tokens, tool_uses, prompt_preview FROM agent_runs ORDER BY agent_id",
  ).all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.["label"], "ground:api");
  assert.equal(rows[0]?.["model"], "claude-sonnet-5");
  assert.equal(rows[0]?.["phase"], "Survey");
  assert.equal(rows[0]?.["workflow_run_id"], "wf_abc123");
  assert.equal(rows[0]?.["total_tokens"], 900);
  assert.equal(rows[0]?.["tool_uses"], 4);
  assert.equal(rows[0]?.["prompt_preview"], "survey the API");
  // startedAt - queuedAt, so a phase that was throttled is distinguishable
  // from a phase that was merely slow.
  assert.equal(rows[0]?.["queued_ms"], 2500);
  // A retry is paid twice; the count has to survive or the cost of a flaky
  // prompt reads as the cost of the model.
  assert.equal(rows[1]?.["attempt"], 2);
  // Absent timings must not become a bogus zero.
  assert.equal(rows[1]?.["queued_ms"], null);

  const wf = d.prepare("SELECT * FROM workflow_runs WHERE run_id='wf_abc123'")
    .get() as Record<string, unknown>;
  assert.equal(wf["default_model"], "claude-opus-5[1m]");
  assert.equal(wf["agent_count"], 2);
  assert.equal(wf["total_tool_calls"], 7);

  // And the read that motivated all of it: cost per kind of task.
  const t = Q.agentTasks(d, {});
  assert.equal(t.groupedBy, "phase");
  assert.equal(t.rows[0]?.["task"], "Survey");
  assert.equal(t.rows[0]?.["agents"], 2);
  const byLabel = Q.agentTasks(d, { groupBy: "label" });
  assert.deepEqual(byLabel.rows.map((r) => r["task"]).sort(), ["ground:api", "impl:T1"]);
  d.close();
});
