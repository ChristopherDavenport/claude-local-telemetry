/**
 * Typed client for the local HTTP API.
 *
 * The shapes here mirror `src/queries.ts` on the server. That module is
 * deliberately the single analytical surface for both the MCP server and this
 * dashboard, so these types are a restatement of its return values rather than
 * a view-model — if a number renders differently here than Claude reports, one
 * of the two is wrong and the shared SQL is how you tell which.
 *
 * Paths are relative, so the same build works served from the API's own origin
 * and behind the Vite dev proxy.
 */

export interface TimeRange {
  from: string | null;
  to: string | null;
}

export interface Overview {
  rows: Record<string, number>;
  timeRange: TimeRange;
  totalCostUsd: number;
  bySource: Record<string, number>;
  note: string;
}

/** A grouped cost bucket. `cost_usd` is null for transcript-sourced rows. */
export interface CostRow {
  grp: string | null;
  n: number;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read: number | null;
  cache_creation: number | null;
}

export interface CostResult {
  groupBy: string;
  rows: CostRow[];
}

export interface SessionRow {
  session_id: string;
  started_at: string | null;
  ended_at: string | null;
  cwd: string | null;
  branch: string | null;
  requests: number;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tool_calls: number;
}

export interface ToolRow {
  ts: string;
  session_id: string | null;
  tool_name: string | null;
  success: number | null;
  duration_ms: number | null;
  decision: string | null;
  decision_source: string | null;
  error_type: string | null;
  input_bytes: number | null;
  result_bytes: number | null;
  cwd: string | null;
}

export interface ToolSummaryRow {
  tool_name: string | null;
  n: number;
  failures: number;
}

export interface ToolAudit {
  summary: ToolSummaryRow[];
  rows: ToolRow[];
}

/**
 * A node of the observability tree.
 *
 * Spans nest by parentage; events are leaves placed inside whichever span was
 * running when they fired. `kind` discriminates, and both carry `children` so
 * the renderer can walk one shape.
 */
export type TraceNode =
  | {
    kind: "span";
    span_id: string;
    parent_id: string | null;
    name: string;
    ts: string;
    duration_ms: number | null;
    attrs: Record<string, unknown>;
    children: TraceNode[];
  }
  | {
    kind: "event";
    name: string;
    ts: string;
    source: string;
    attrs: Record<string, unknown>;
    children: TraceNode[];
  };

export interface TraceResult {
  traceId: string | null;
  sessionId: string | null;
  spanCount: number;
  eventCount: number;
  truncatedEvents: boolean;
  tree: TraceNode[];
  /** Present only when the trace has no spans; explains why, and what is shown instead. */
  note?: string;
}

export interface TraceListRow {
  trace_id: string;
  started_at: string;
  span_count: number;
  session_id: string | null;
  root_name: string | null;
  duration_ms: number | null;
}

export interface TraceList {
  rows: TraceListRow[];
  note?: string;
}

export interface QueryRow {
  grp?: string | null;
  value: number | null;
}

export interface QueryResult {
  table: string;
  calculate: string;
  breakdown: string | null;
  rows: QueryRow[];
}

/* ------------------------------------------------------------------ *
 * Agents, teams and workflows.
 *
 * Every token figure here is *measured* — summed from the requests the agent's
 * own transcript recorded — rather than the totals the spawning call reported.
 * `reported_tokens` is the reported figure, kept alongside so the two can be
 * compared; it is null for any agent that was backgrounded and never came back.
 * ------------------------------------------------------------------ */

export interface WorkflowRow {
  run_id: string;
  started_at: string;
  name: string | null;
  session_id: string | null;
  script_path: string | null;
  summary: string | null;
  agents: number;
  requests: number;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface WorkflowList {
  rows: WorkflowRow[];
  note?: string;
}

export interface AgentRow {
  agent_id: string;
  session_id: string | null;
  workflow_run_id: string | null;
  requests: number;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  started_at: string | null;
  ended_at: string | null;
  agent_type: string | null;
  label: string | null;
  team_name: string | null;
  model: string | null;
  status: string | null;
  reported_tokens: number | null;
}

export interface AgentList {
  rows: AgentRow[];
  /** Spawns the parent recorded that produced no measurable turns. */
  spawnsWithoutTurns: number;
}

export interface WorkflowDetail {
  run: Record<string, unknown> | null;
  agentCount: number;
  agents: Array<Pick<AgentRow, "agent_id" | "requests" | "cost_usd" | "input_tokens"
    | "output_tokens" | "started_at" | "ended_at" | "agent_type" | "label">>;
  tools: Array<{ tool_name: string | null; n: number }>;
}

export interface TeamRow {
  team_name: string;
  members: number;
  agent_types: number;
  started_at: string | null;
  requests: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

export interface PluginCostRow {
  plugin: string | null;
  n: number;
  cost_usd: number | null;
}

export interface PluginHashRow {
  plugin_id_hash: string | null;
  plugin_name: string | null;
  marketplace: string | null;
  skill_count: number | null;
  agent_count: number | null;
  resolved: string | null;
}

export interface InvocationRow {
  skill: string | null;
  agent: string | null;
  n: number;
}

export interface PluginCosts {
  attributed: PluginCostRow[];
  blinded: { requests: number; costUsd: number | null };
  skillAgentInvocationsFromTranscripts: InvocationRow[];
  pluginHashes: PluginHashRow[];
  note: string;
}

export interface HookRow {
  hook_name: string | null;
  hook_event: string | null;
  runs: number;
  hooks_invoked: number | null;
  succeeded: number | null;
  errored: number | null;
  blocked: number | null;
  avg_ms: number | null;
}

export interface HookHealth {
  verdict: string;
  runs: number;
  totalErrors: number;
  failing: HookRow[];
  byHook: HookRow[];
  note: string;
}

/** The server's 400 body is `{error}`; surface that text rather than the status. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type Params = Record<string, string | number | boolean | undefined>;

async function get<T>(path: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  const url = `/api/${path}${q.size ? `?${q}` : ""}`;

  let res: Response;
  try {
    res = await fetch(url, signal ? { signal } : {});
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    // The overwhelmingly likely cause, and the one worth naming: the API isn't
    // running. A bare "Failed to fetch" sends people to the browser console.
    throw new ApiError(0, `cannot reach the API at ${location.origin}. Start it with \`claude-local-telemetry api\`.`);
  }

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : `request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export interface Range {
  since?: string | undefined;
  until?: string | undefined;
}

/**
 * Every optional field is spelled `?: T | undefined` rather than `?: T`.
 *
 * Under `exactOptionalPropertyTypes` those are different types, and callers
 * here build option bags from filter state that is legitimately `undefined`
 * ("no filter"). Declaring `?: T` would force every call site to strip its
 * undefined keys before calling. This is the same distinction that bit the
 * server during its TypeScript port; widening the type is the fix, not
 * relaxing the flag.
 */
type Opt<T> = T | undefined;

export const api = {
  overview: (signal?: AbortSignal) => get<Overview>("overview", {}, signal),

  cost: (
    o: Range & { groupBy?: Opt<string>; limit?: Opt<number>; sessionId?: Opt<string> } = {},
    signal?: AbortSignal,
  ) =>
    get<CostResult>("cost", {
      group_by: o.groupBy, since: o.since, until: o.until, limit: o.limit,
      session_id: o.sessionId,
    }, signal),

  sessions: (
    o: { since?: Opt<string>; cwdLike?: Opt<string>; limit?: Opt<number>;
         sessionId?: Opt<string> } = {},
    signal?: AbortSignal,
  ) =>
    get<{ rows: SessionRow[] }>("sessions", {
      since: o.since, cwd_like: o.cwdLike, limit: o.limit, session_id: o.sessionId,
    }, signal),

  tools: (o: {
    toolName?: Opt<string>; decision?: Opt<string>; success?: Opt<boolean>;
    since?: Opt<string>; limit?: Opt<number>;
    sessionId?: Opt<string>; agentId?: Opt<string>;
  } = {}, signal?: AbortSignal) =>
    get<ToolAudit>("tools", {
      tool_name: o.toolName, decision: o.decision, success: o.success,
      since: o.since, limit: o.limit,
      session_id: o.sessionId, agent_id: o.agentId,
    }, signal),

  workflows: (
    o: { since?: Opt<string>; sessionId?: Opt<string>; limit?: Opt<number> } = {},
    signal?: AbortSignal,
  ) =>
    get<WorkflowList>("workflows", {
      since: o.since, session_id: o.sessionId, limit: o.limit,
    }, signal),

  workflow: (o: { runId: string }, signal?: AbortSignal) =>
    get<WorkflowDetail>("workflow", { run_id: o.runId }, signal),

  agents: (o: {
    sessionId?: Opt<string>; team?: Opt<string>; runId?: Opt<string>;
    since?: Opt<string>; limit?: Opt<number>;
  } = {}, signal?: AbortSignal) =>
    get<AgentList>("agents", {
      session_id: o.sessionId, team: o.team, run_id: o.runId,
      since: o.since, limit: o.limit,
    }, signal),

  teams: (o: { since?: Opt<string>; limit?: Opt<number> } = {}, signal?: AbortSignal) =>
    get<{ rows: TeamRow[] }>("teams", { since: o.since, limit: o.limit }, signal),

  traces: (
    o: { since?: Opt<string>; sessionId?: Opt<string>; limit?: Opt<number> } = {},
    signal?: AbortSignal,
  ) =>
    get<TraceList>("traces", {
      since: o.since, session_id: o.sessionId, limit: o.limit,
    }, signal),

  trace: (
    o: { traceId?: Opt<string>; sessionId?: Opt<string>; events?: Opt<boolean> },
    signal?: AbortSignal,
  ) =>
    get<TraceResult>("trace", {
      trace_id: o.traceId, session_id: o.sessionId, events: o.events,
    }, signal),

  /** Raw read-only SELECT. The server rejects anything that is not one. */
  sql: (o: { query: string; limit?: Opt<number> }, signal?: AbortSignal) =>
    get<{ rows: Array<Record<string, unknown>> }>("sql", {
      query: o.query, limit: o.limit,
    }, signal),

  query: (o: {
    table?: Opt<string>; calculate?: Opt<string>; breakdown?: Opt<string>; where?: Opt<string>;
    since?: Opt<string>; until?: Opt<string>; limit?: Opt<number>;
  } = {}, signal?: AbortSignal) =>
    get<QueryResult>("query", {
      table: o.table, calculate: o.calculate, breakdown: o.breakdown,
      where: o.where, since: o.since, until: o.until, limit: o.limit,
    }, signal),

  plugins: (signal?: AbortSignal) => get<PluginCosts>("plugins", {}, signal),

  hooks: (o: { since?: Opt<string>; limit?: Opt<number> } = {}, signal?: AbortSignal) =>
    get<HookHealth>("hooks", { since: o.since, limit: o.limit }, signal),
};

/* ------------------------------------------------------------------ *
 * Vocabularies the server validates against. Mirrored here so the UI
 * offers exactly the accepted values instead of discovering them by
 * round-tripping a 400.
 * ------------------------------------------------------------------ */

export const COST_GROUPS = [
  "day", "hour", "model", "query_source", "plugin_resolved", "skill_name",
  "agent_name", "session_id", "cwd", "git_branch", "speed", "effort",
] as const;

export const TABLES = [
  "api_requests", "tool_calls", "events", "spans", "metrics",
  "sessions", "plugin_loads", "plugin_alias", "hook_runs",
] as const;

export const AGGS = [
  "count", "sum_cost", "sum_input", "sum_output", "sum_cache_read",
  "sum_cache_creation", "avg_duration", "max_duration", "sum_duration",
] as const;

/** Columns worth offering as a breakdown, per table. The server accepts any
 *  real column; these are the ones that group into something readable. */
export const BREAKDOWNS: Record<string, readonly string[]> = {
  api_requests: [
    "model", "query_source", "plugin_resolved", "skill_name", "agent_name",
    "speed", "effort", "cwd", "git_branch", "source", "mcp_server", "mcp_tool",
  ],
  tool_calls: ["tool_name", "decision", "decision_source", "error_type", "success", "cwd", "source"],
  events: ["name", "source"],
  spans: ["name"],
  metrics: ["name"],
  sessions: ["cwd", "git_branch", "entrypoint", "app_version", "source"],
  plugin_loads: ["plugin_name", "marketplace", "scope", "version"],
  plugin_alias: ["plugin_name", "marketplace", "confidence"],
  hook_runs: ["hook_name", "hook_event", "hook_source"],
};
