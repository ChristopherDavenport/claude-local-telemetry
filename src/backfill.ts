/**
 * Import existing Claude Code transcripts into the telemetry store.
 *
 * Why bother when the sink exists
 * -------------------------------
 * The sink only sees sessions that happen after it is running. The transcripts
 * are already on disk and cover months, so importing them means the store
 * answers questions on day one instead of after a fortnight of accumulation.
 *
 * They also see something OTel cannot. OTel redacts every third-party plugin and
 * skill to the literal string `third-party`; transcripts record the actual
 * `Skill` and `Agent` tool calls with real names. For attributing spend to *your
 * own* plugins, the transcripts are the un-redacted source.
 *
 * What they lack
 * --------------
 * **No cost.** Transcripts carry exact token counts but no `cost_usd` — that is
 * computed server-side and only OTel reports it. Rows imported here leave
 * `cost_usd` NULL rather than guessing from a price table that would silently
 * rot. Token counts are exact and are the honest basis for comparison; `stats`
 * breaks rows down by source so the gap is visible rather than assumed away.
 *
 * Where both sources describe the same request the row is merged, not
 * duplicated: whichever arrives second fills NULLs via COALESCE without
 * clobbering what is already there, and `source` becomes `otel+transcript`.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { init } from "./store.ts";

export const UPSERT_API = `
INSERT INTO api_requests (
    request_id, ts, session_id, model, cost_usd,
    input_tokens, output_tokens, cache_read, cache_creation,
    duration_ms, query_source, speed, effort,
    agent_name, skill_name, plugin_name, marketplace_name, plugin_resolved,
    mcp_server, mcp_tool, cwd, git_branch, source, agent_id, workflow_run_id
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(request_id) DO UPDATE SET
    ts             = COALESCE(api_requests.ts, excluded.ts),
    session_id     = COALESCE(api_requests.session_id, excluded.session_id),
    model          = COALESCE(api_requests.model, excluded.model),
    cost_usd       = COALESCE(api_requests.cost_usd, excluded.cost_usd),
    input_tokens   = COALESCE(api_requests.input_tokens, excluded.input_tokens),
    output_tokens  = COALESCE(api_requests.output_tokens, excluded.output_tokens),
    cache_read     = COALESCE(api_requests.cache_read, excluded.cache_read),
    cache_creation = COALESCE(api_requests.cache_creation, excluded.cache_creation),
    cwd            = COALESCE(api_requests.cwd, excluded.cwd),
    git_branch     = COALESCE(api_requests.git_branch, excluded.git_branch),
    -- The point of merging the two sources. OTel wrote 'third-party' into
    -- plugin_name for anything outside the official marketplace; the transcript
    -- knows the real name and lands here for the same request_id. COALESCE, so
    -- a name already resolved is never overwritten by a later null.
    skill_name      = COALESCE(api_requests.skill_name, excluded.skill_name),
    plugin_resolved = COALESCE(api_requests.plugin_resolved, excluded.plugin_resolved),
    mcp_server      = COALESCE(api_requests.mcp_server, excluded.mcp_server),
    mcp_tool        = COALESCE(api_requests.mcp_tool, excluded.mcp_tool),
    source         = CASE WHEN api_requests.source = excluded.source
                          THEN api_requests.source ELSE 'otel+transcript' END`;

export interface BackfillCounts {
  api: number; tools: number; sessions: number; skills: number;
  agents: number; workflows: number;
}

interface Block { type?: string; id?: string; name?: string | undefined; input?: Record<string, unknown>;
                  tool_use_id?: string; content?: unknown; is_error?: boolean }
interface Msg { content?: unknown; model?: string; usage?: Record<string, unknown> }
interface Rec {
  type?: string; timestamp?: string; sessionId?: string; requestId?: string;
  uuid?: string; cwd?: string | undefined; gitBranch?: string; entrypoint?: string | undefined;
  version?: string | undefined; isSidechain?: boolean; message?: Msg;
  // Un-redacted attribution. OTel reports every non-official plugin as the
  // literal "third-party"; the transcript names it outright, on the same
  // record as the requestId, so the two join with no inference at all.
  attributionPlugin?: string; attributionSkill?: string;
  attributionMcpServer?: string; attributionMcpTool?: string;
  // Structured result of the tool call this record answers.
  toolUseResult?: Record<string, unknown>;
}

export interface PathContext {
  kind: "main" | "agent";
  parentSessionId: string | null;
  agentId: string | null;
  workflowRunId: string | null;
}

/**
 * What a transcript's location says about it.
 *
 * Claude Code lays subagent transcripts out under the session that spawned
 * them:
 *
 *   <project>/<sessionId>.jsonl                                       main
 *   <project>/<parent>/subagents/agent-<id>.jsonl                     agent
 *   <project>/<parent>/subagents/workflows/<runId>/agent-<id>.jsonl   workflow agent
 *
 * so which agent produced a transcript, and which workflow run it belonged to,
 * is in the path and nowhere else.
 *
 * The records inside carry the *parent's* `sessionId`, or none at all — so an
 * agent is not a separate session. Its turns simply landed in the parent's
 * session unlabelled, which is why
 * `agent_id` hangs off `api_requests` and `tool_calls` rather than `sessions`.
 */
export function pathContext(file: string, root: string): PathContext {
  const rel = relative(root, file).split(sep);
  const i = rel.indexOf("subagents");
  if (i <= 0) return { kind: "main", parentSessionId: null, agentId: null, workflowRunId: null };

  const base = rel[rel.length - 1] ?? "";
  const m = /^agent-(.+)\.jsonl$/.exec(base);
  return {
    kind: "agent",
    parentSessionId: rel[i - 1] ?? null,
    agentId: m?.[1] ?? null,
    workflowRunId: rel[i + 1] === "workflows" ? (rel[i + 2] ?? null) : null,
  };
}

function blocks(m: Msg | undefined): Block[] {
  return Array.isArray(m?.content) ? (m.content as Block[]) : [];
}

/**
 * Size proxy for a tool input or result.
 *
 * Compact JSON, deliberately: it is not a token count and not the wire size,
 * just a stable relative measure of how much a call carried. Worth stating
 * because the figure is not comparable across serialisers — Python's
 * `json.dumps` inserts `", "` and `": "` separators and reports ~7% larger for
 * the same object, which showed up as a clean divergence when this was ported.
 */
function sizeOf(v: unknown): number {
  return typeof v === "string" ? v.length : JSON.stringify(v ?? "").length;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Booleans have to become INTEGER or NULL before a STRICT table will take them. */
function bit(v: unknown): number | null {
  return v === true || v === "true" ? 1 : v === false || v === "false" ? 0 : null;
}

/**
 * One agent spawn, assembled from both halves of the tool call.
 *
 * The Agent tool's *input* carries what was asked for (subagent_type, name,
 * description, model); its *result* carries what happened (agentId, team_name,
 * status, and — for a synchronous agent that ran to completion — the token and
 * duration totals). Neither half is sufficient, and the shapes differ between a
 * plain agent, a named teammate and a backgrounded one, so every field is read
 * from whichever key that variant used.
 *
 * Falls back to the tool_use_id for identity: a completed synchronous agent
 * reports totals with no id of its own, and dropping those rows would lose the
 * only records that carry real agent cost.
 */
function agentRow(
  toolUseId: string,
  ts: string,
  parentSessionId: string | null,
  input: Record<string, unknown> | undefined,
  res: Record<string, unknown>,
): [string, string, string | null, string | null, string | null, string | null,
    string | null, string | null, string | null, number | null, string | null,
    number | null, number | null, number | null, string] {
  const i = input ?? {};
  return [
    str(res["agentId"]) ?? str(res["agent_id"]) ?? str(res["teammate_id"]) ?? toolUseId,
    ts,
    parentSessionId,
    null, // workflow agents are spawned by the runtime, not from a visible call
    str(res["agent_type"]) ?? str(res["agentType"]) ?? str(i["subagent_type"]),
    str(res["name"]) ?? str(i["name"]),
    str(res["team_name"]),
    str(res["model"]) ?? str(res["resolvedModel"]) ?? str(i["model"]),
    str(res["status"]),
    bit(res["isAsync"] ?? i["run_in_background"]),
    str(res["description"]) ?? str(i["description"]),
    num(res["totalTokens"]),
    num(res["totalDurationMs"]),
    num(res["totalToolUseCount"]),
    "transcript",
  ];
}

/** Recursively list *.jsonl under a root. */
export function findTranscripts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

export function importFile(
  db: DatabaseSync, path: string, since: string | null, dry: boolean,
  ctx: PathContext = { kind: "main", parentSessionId: null, agentId: null, workflowRunId: null },
): BackfillCounts {
  const counts: BackfillCounts = {
    api: 0, tools: 0, sessions: 0, skills: 0, agents: 0, workflows: 0,
  };
  const sessionSeen = new Map<string, {
    started: string; ended: string; cwd?: string | undefined; branch?: string | undefined;
    entrypoint?: string | undefined; version?: string | undefined;
    firstPrompt?: string | undefined;
  }>();
  const pendingTools = new Map<string, {
    ts: string; sid?: string | undefined; name?: string | undefined; bytes: number; cwd?: string | undefined;
    // Kept only for Agent and Workflow: the spawn's parameters live in the
    // input and its identity in the result, so the row needs both halves.
    input?: Record<string, unknown> | undefined;
  }>();

  const upsertApi = db.prepare(UPSERT_API);
  const insEvent = db.prepare(
    "INSERT OR IGNORE INTO events(ts, session_id, name, attrs, source) VALUES (?,?,?,?,?)");
  const insTool = db.prepare(
    "INSERT OR IGNORE INTO tool_calls (ts, session_id, tool_use_id, tool_name, success," +
    " duration_ms, decision, decision_source, error_type, input_bytes, result_bytes," +
    " mcp_scope, cwd, source, agent_id, workflow_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  // COALESCE on update: a backgrounded agent acknowledges first and reports its
  // totals later, and the second record must not blank the first one's fields.
  const insAgent = db.prepare(
    "INSERT INTO agent_runs (agent_id, ts, parent_session_id, workflow_run_id," +
    " agent_type, label, team_name, model, status, is_async, description," +
    " total_tokens, duration_ms, tool_uses, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)" +
    " ON CONFLICT(agent_id) DO UPDATE SET" +
    "  agent_type   = COALESCE(agent_runs.agent_type, excluded.agent_type)," +
    "  label        = COALESCE(agent_runs.label, excluded.label)," +
    "  team_name    = COALESCE(agent_runs.team_name, excluded.team_name)," +
    "  model        = COALESCE(agent_runs.model, excluded.model)," +
    "  status       = COALESCE(excluded.status, agent_runs.status)," +
    "  description  = COALESCE(agent_runs.description, excluded.description)," +
    "  total_tokens = COALESCE(excluded.total_tokens, agent_runs.total_tokens)," +
    "  duration_ms  = COALESCE(excluded.duration_ms, agent_runs.duration_ms)," +
    "  tool_uses    = COALESCE(excluded.tool_uses, agent_runs.tool_uses)");
  const insWorkflow = db.prepare(
    "INSERT INTO workflow_runs (run_id, ts, name, session_id, script_path, summary, source)" +
    " VALUES (?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET" +
    "  name        = COALESCE(workflow_runs.name, excluded.name)," +
    "  script_path = COALESCE(workflow_runs.script_path, excluded.script_path)," +
    "  summary     = COALESCE(excluded.summary, workflow_runs.summary)");

  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return counts; }

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: Rec;
    // A partially-flushed final line is normal on a live session.
    try { rec = JSON.parse(line) as Rec; } catch { continue; }

    const ts = rec.timestamp;
    if (!ts || (since && ts < since)) continue;
    const sid = rec.sessionId;

    if (sid && !sessionSeen.has(sid)) {
      sessionSeen.set(sid, {
        started: ts, ended: ts, cwd: rec.cwd, branch: rec.gitBranch,
        entrypoint: rec.entrypoint, version: rec.version,
      });
    } else if (sid) {
      const s = sessionSeen.get(sid)!;
      if (ts > s.ended) s.ended = ts;
    }

    if (sid && rec.type === "user") {
      const s = sessionSeen.get(sid)!;
      if (s.firstPrompt === undefined) {
        const opening = openingAsk(rec.message);
        if (opening) s.firstPrompt = opening;
      }
    }

    if (rec.type === "assistant") {
      const msg = rec.message ?? {};
      let usage = msg.usage ?? {};
      // A requestId legitimately repeats across records — one API call can
      // produce several assistant records, and 3510 of 3511 repeats in a real
      // corpus carry byte-identical usage, so collapsing to one row loses
      // nothing. The exception is a real accounting followed by all-zero rows;
      // those zeros are not a measurement, and taking whichever landed first
      // would silently undercount that request.
      const anyUsage = ["input_tokens", "output_tokens",
        "cache_read_input_tokens", "cache_creation_input_tokens"]
        .some((k) => Number(usage[k] ?? 0) > 0);
      if (!anyUsage) usage = {};

      // A handful of records carry usage but no requestId. Falling back to the
      // record uuid keeps them rather than dropping them on the floor.
      const rid = rec.requestId ?? (rec.uuid ? `uuid:${rec.uuid}` : null);
      if (rid && Object.keys(usage).length) {
        if (!dry) {
          upsertApi.run(
            rid, ts, sid ?? null, msg.model ?? null, null,
            num(usage["input_tokens"]), num(usage["output_tokens"]),
            num(usage["cache_read_input_tokens"]), num(usage["cache_creation_input_tokens"]),
            null,
            // `isSidechain` is the old marker and is false on every record in a
            // modern corpus; the transcript's own location is what actually
            // says whether this is agent work.
            ctx.kind === "agent" || rec.isSidechain ? "subagent" : "main",
            (usage["speed"] as string | undefined) ?? null, null,
            null, rec.attributionSkill ?? null, null, null,
            rec.attributionPlugin ?? null,
            rec.attributionMcpServer ?? null, rec.attributionMcpTool ?? null,
            rec.cwd ?? null, rec.gitBranch ?? null, "transcript",
            ctx.agentId, ctx.workflowRunId,
          );
        }
        counts.api++;
      }

      for (const b of blocks(msg)) {
        if (b?.type !== "tool_use" || !b.id) continue;
        const input = b.input ?? {};
        pendingTools.set(b.id, {
          ts, sid, name: b.name, bytes: sizeOf(input), cwd: rec.cwd,
          ...(b.name === "Agent" || b.name === "Workflow" ? { input } : {}),
        });
        // Skill/Agent invocations are the un-redacted attribution OTel will not
        // give us; keep them as events for the resolver.
        if ((b.name === "Skill" || b.name === "Agent") && !dry) {
          insEvent.run(ts, sid ?? null, `transcript.${b.name.toLowerCase()}_invoked`,
            JSON.stringify({
              skill: input["skill"] ?? null,
              subagent_type: input["subagent_type"] ?? null,
              cwd: rec.cwd ?? null,
            }), "transcript");
          counts.skills++;
        }
      }
    } else if (rec.type === "user") {
      for (const b of blocks(rec.message)) {
        if (b?.type !== "tool_result") continue;
        const tid = b.tool_use_id;
        if (!tid) continue;
        const info = pendingTools.get(tid);
        if (!info) continue;
        pendingTools.delete(tid);
        const body = b.content;
        const size = sizeOf(body);
        if (!dry) {
          insTool.run(info.ts, info.sid ?? null, tid, info.name ?? null,
            b.is_error ? 0 : 1, null, null, null, b.is_error ? "error" : null,
            info.bytes, size, null, info.cwd ?? null, "transcript",
            ctx.agentId, ctx.workflowRunId);
        }
        counts.tools++;

        // The spawn, as the parent saw it. `toolUseResult` sits on the record
        // rather than in the tool_result block.
        const res = rec.toolUseResult;
        if (res && !dry) {
          if (info.name === "Agent") {
            insAgent.run(...agentRow(tid, info.ts, info.sid ?? null, info.input, res));
            counts.agents++;
          } else if (info.name === "Workflow" && str(res["runId"])) {
            insWorkflow.run(
              str(res["runId"]), info.ts, str(res["workflowName"]) ?? str(info.input?.["name"]),
              info.sid ?? null, str(res["scriptPath"]), str(res["summary"]), "transcript",
            );
            counts.workflows++;
          }
        }
      }
    }
  }

  // Tool calls with no matching result: the session ended mid-flight, or the
  // result was filtered. Record them rather than dropping — an unanswered tool
  // call is exactly the shape of an audit question.
  for (const [tid, info] of pendingTools) {
    if (!dry) {
      insTool.run(info.ts, info.sid ?? null, tid, info.name ?? null,
        null, null, null, null, "no_result", info.bytes, null, null,
        info.cwd ?? null, "transcript", ctx.agentId, ctx.workflowRunId);
    }
    counts.tools++;
  }

  const upsertSession = db.prepare(
    "INSERT INTO sessions(session_id, started_at, ended_at, cwd, git_branch," +
    " entrypoint, app_version, source, first_prompt) VALUES (?,?,?,?,?,?,?,?,?)" +
    " ON CONFLICT(session_id) DO UPDATE SET" +
    "  started_at = MIN(sessions.started_at, excluded.started_at)," +
    "  ended_at   = MAX(sessions.ended_at,   excluded.ended_at)," +
    "  cwd        = COALESCE(sessions.cwd, excluded.cwd)," +
    "  git_branch = COALESCE(sessions.git_branch, excluded.git_branch)," +
    // First write wins: re-running backfill over a longer transcript must not
    // replace the opening ask with a later turn.
    "  first_prompt = COALESCE(sessions.first_prompt, excluded.first_prompt)");
  for (const [sid, s] of sessionSeen) {
    if (!dry) {
      upsertSession.run(sid, s.started, s.ended, s.cwd ?? null, s.branch ?? null,
        s.entrypoint ?? null, s.version ?? null, "transcript", s.firstPrompt ?? null);
    }
    counts.sessions++;
  }

  return counts;
}


/**
 * The session's opening ask, or null if this user record isn't one.
 *
 * A transcript's first `user` record is frequently not the operator speaking.
 * Slash commands arrive wrapped in a caveat block explaining that the text was
 * machine-generated and should be ignored; command output arrives as
 * `<local-command-stdout>`; the harness injects `<system-reminder>` blocks; and
 * a tool result is a user-role record carrying no prose at all. Taking the
 * literal first one yields "Caveat: The messages below were generated by..." as
 * the name of the work, which is worse than having no name.
 *
 * Returns the first block of genuine prose, trimmed to a length that is useful
 * for labelling without storing the whole turn.
 */
export function openingAsk(message: unknown): string | null {
  const m = message as { content?: unknown } | undefined;
  const content = m?.content;
  const texts: string[] = [];
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      const blk = b as { type?: string; text?: string } | null;
      if (blk?.type === "text" && typeof blk.text === "string") texts.push(blk.text);
    }
  }

  for (const raw of texts) {
    // Strip the wrappers rather than skipping the record: a slash-command turn
    // often carries the caveat AND the real ask in one block.
    const cleaned = raw
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
      .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
      .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, "")
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
      .trim();
    // A bare slash command is a real ask but a poor label on its own; keep it
    // only if nothing better follows in the same turn.
    if (cleaned.length >= 12) return cleaned.slice(0, 2000);
  }
  return null;
}

/**
 * Import one workflow run manifest.
 *
 * `<project>/<session>/workflows/<runId>.json` is written by the workflow
 * runtime and, until v4, read by nothing. It is the only place a workflow
 * agent's *label* exists -- the transcript path yields an opaque agent id and
 * the parent session has no `Agent` tool call to describe the spawn, because
 * the runtime spawned it. Without this, workflow agents are cost with no task
 * attached, which on this machine was 94% of subagent spend.
 *
 * Every field here is the runtime's own account of the run. Where it overlaps
 * with what the transcripts already established, the transcript wins on
 * identity (`agent_id`, timestamps) and this wins on intent (`label`, `model`,
 * `phase`) -- see the COALESCE direction in the upserts.
 */
export function importWorkflowManifest(
  db: DatabaseSync, path: string, dry: boolean,
): { workflows: number; agents: number } {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // A run still in flight can be mid-write. It will be picked up next pass.
    return { workflows: 0, agents: 0 };
  }

  const runId = str(doc["runId"]);
  if (!runId) return { workflows: 0, agents: 0 };

  // The session that owns the run is the directory above `workflows/`, which is
  // more reliable than anything inside the file: a resumed run keeps its
  // original `taskId` but lands under whichever session resumed it.
  const parts = path.split(sep);
  const wi = parts.lastIndexOf("workflows");
  const sessionId = wi > 0 ? (parts[wi - 1] ?? null) : null;

  const startedMs = num(doc["startTime"]);
  const ts = str(doc["timestamp"])
    ?? (startedMs !== null ? new Date(startedMs).toISOString() : new Date(0).toISOString());

  if (dry) {
    const n = (doc["workflowProgress"] as unknown[] | undefined)?.length ?? 0;
    return { workflows: 1, agents: n };
  }

  db.prepare(
    "INSERT INTO workflow_runs (run_id, ts, name, session_id, script_path, summary, source," +
    " default_model, status, agent_count, total_tokens, total_tool_calls, duration_ms)" +
    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET" +
    "  name             = COALESCE(excluded.name, workflow_runs.name)," +
    "  session_id       = COALESCE(workflow_runs.session_id, excluded.session_id)," +
    "  script_path      = COALESCE(excluded.script_path, workflow_runs.script_path)," +
    "  summary          = COALESCE(excluded.summary, workflow_runs.summary)," +
    "  default_model    = COALESCE(excluded.default_model, workflow_runs.default_model)," +
    "  status           = COALESCE(excluded.status, workflow_runs.status)," +
    "  agent_count      = COALESCE(excluded.agent_count, workflow_runs.agent_count)," +
    "  total_tokens     = COALESCE(excluded.total_tokens, workflow_runs.total_tokens)," +
    "  total_tool_calls = COALESCE(excluded.total_tool_calls, workflow_runs.total_tool_calls)," +
    "  duration_ms      = COALESCE(excluded.duration_ms, workflow_runs.duration_ms)",
  ).run(
    runId, ts, str(doc["workflowName"]), sessionId, str(doc["scriptPath"]),
    str(doc["summary"]), "manifest", str(doc["defaultModel"]), str(doc["status"]),
    num(doc["agentCount"]), num(doc["totalTokens"]), num(doc["totalToolCalls"]),
    num(doc["durationMs"]),
  );

  // COALESCE keeps whichever side knows a field: the manifest is authoritative
  // for label/model/phase, the transcript for anything it already measured.
  const insAgent = db.prepare(
    "INSERT INTO agent_runs (agent_id, ts, parent_session_id, workflow_run_id," +
    " agent_type, label, model, status, description, total_tokens, duration_ms," +
    " tool_uses, source, phase, phase_index, attempt, queued_ms," +
    " prompt_preview, result_preview) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)" +
    " ON CONFLICT(agent_id) DO UPDATE SET" +
    "  workflow_run_id = COALESCE(excluded.workflow_run_id, agent_runs.workflow_run_id)," +
    "  label           = COALESCE(excluded.label, agent_runs.label)," +
    "  model           = COALESCE(excluded.model, agent_runs.model)," +
    "  status          = COALESCE(excluded.status, agent_runs.status)," +
    "  total_tokens    = COALESCE(agent_runs.total_tokens, excluded.total_tokens)," +
    "  duration_ms     = COALESCE(agent_runs.duration_ms, excluded.duration_ms)," +
    "  tool_uses       = COALESCE(agent_runs.tool_uses, excluded.tool_uses)," +
    "  phase           = COALESCE(excluded.phase, agent_runs.phase)," +
    "  phase_index     = COALESCE(excluded.phase_index, agent_runs.phase_index)," +
    "  attempt         = COALESCE(excluded.attempt, agent_runs.attempt)," +
    "  queued_ms       = COALESCE(excluded.queued_ms, agent_runs.queued_ms)," +
    "  prompt_preview  = COALESCE(excluded.prompt_preview, agent_runs.prompt_preview)," +
    "  result_preview  = COALESCE(excluded.result_preview, agent_runs.result_preview)");

  let agents = 0;
  const progress = Array.isArray(doc["workflowProgress"]) ? doc["workflowProgress"] : [];
  for (const raw of progress) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (e["type"] !== "workflow_agent") continue;
    const agentId = str(e["agentId"]);
    if (!agentId) continue;

    const queued = num(e["queuedAt"]);
    const started = num(e["startedAt"]);
    // Only meaningful when both halves are present and ordered; a resumed run
    // replays cached agents with a startedAt older than its queuedAt.
    const queuedMs = queued !== null && started !== null && started >= queued
      ? started - queued : null;

    insAgent.run(
      agentId,
      started !== null ? new Date(started).toISOString() : ts,
      sessionId,
      runId,
      "workflow-subagent",
      str(e["label"]),
      str(e["model"]),
      str(e["state"]),
      // `description` is the Agent tool's word for intent; for a workflow agent
      // the label is the intent and the prompt is the detail, so the preview
      // goes to its own column and description stays null rather than
      // pretending to be something the parent declared.
      null,
      num(e["tokens"]),
      num(e["durationMs"]),
      num(e["toolCalls"]),
      "manifest",
      str(e["phaseTitle"]),
      num(e["phaseIndex"]),
      num(e["attempt"]),
      queuedMs,
      clip(str(e["promptPreview"]), 2000),
      clip(str(e["resultPreview"]), 2000),
    );
    agents++;
  }
  return { workflows: 1, agents };
}

function clip(s: string | null, n: number): string | null {
  return s === null ? null : (s.length > n ? s.slice(0, n) : s);
}

/** Every `<project>/<session>/workflows/<runId>.json` under a root. */
export function findWorkflowManifests(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      // `workflows/scripts/` holds the .js sources, not manifests.
      if (st.isDirectory()) { if (e !== "scripts") walk(p); }
      else if (e.startsWith("wf_") && e.endsWith(".json")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

export interface BackfillOptions {
  root?: string | undefined; db?: string | undefined; since?: string | null; dryRun?: boolean | undefined; quiet?: boolean | undefined;
}

export function backfill(opts: BackfillOptions = {}): BackfillCounts & { files: number } {
  const root = opts.root ?? join(homedir(), ".claude", "projects");
  if (!existsSync(root)) throw new Error(`no transcript root at ${root}`);

  const db = init(opts.db);
  const files = findTranscripts(root);
  const total: BackfillCounts = {
    api: 0, tools: 0, sessions: 0, skills: 0, agents: 0, workflows: 0,
  };

  db.exec("BEGIN");
  let i = 0;
  for (const f of files) {
    let c: BackfillCounts;
    try {
      c = importFile(db, f, opts.since ?? null, opts.dryRun ?? false, pathContext(f, root));
    } catch (err) {
      // One bad transcript must not abort the import.
      process.stderr.write(`  skipped ${f}: ${(err as Error).message}\n`);
      continue;
    }
    total.api += c.api; total.tools += c.tools;
    total.sessions += c.sessions; total.skills += c.skills;
    total.agents += c.agents; total.workflows += c.workflows;
    if (!opts.quiet && ++i % 200 === 0) process.stderr.write(`  ${i}/${files.length} files…\n`);
  }

  // After the transcripts, not before: the manifests upsert onto agent rows the
  // transcripts may have created, and the COALESCE directions above assume the
  // transcript's measured figures are already in place.
  const manifests = findWorkflowManifests(root);
  for (const m of manifests) {
    try {
      const c = importWorkflowManifest(db, m, opts.dryRun ?? false);
      total.workflows += c.workflows;
      total.agents += c.agents;
    } catch (err) {
      process.stderr.write(`  skipped ${m}: ${(err as Error).message}\n`);
    }
  }
  if (!opts.quiet && manifests.length) {
    process.stderr.write(`  ${manifests.length} workflow manifest(s)\n`);
  }

  db.exec("COMMIT");
  db.close();
  return { ...total, files: files.length + manifests.length };
}
