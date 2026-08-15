/**
 * MCP server over the telemetry store, speaking stdio JSON-RPC.
 *
 * No SDK — the protocol surface needed here is three methods, and a dependency
 * is a thing that can fail to install on a machine whose whole appeal is that
 * nothing had to be installed.
 *
 * Everything is read-only, against a WAL database, so querying never blocks the
 * sink and cannot corrupt anything mid-write.
 *
 * The tool set is deliberately small. A wide surface costs context on every
 * session, which is a poor trade for a plugin whose entire subject is context
 * cost. `telemetry_run_query` is the general one; the rest exist because the
 * common questions deserve one call rather than a correctly-shaped SQL string.
 *
 * NOTE: nothing may write to stdout except protocol frames. Diagnostics go to
 * stderr, and the CLI suppresses the node:sqlite experimental warning for the
 * same reason.
 */

import { createInterface } from "node:readline";
import { openForRead } from "./store.ts";
import * as Q from "./queries.ts";

const PROTOCOL = "2024-11-05";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (db: ReturnType<typeof openForRead>, args: Record<string, unknown>) => unknown;
}

const obj = (props: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object", properties: props, ...(required.length ? { required } : {}),
});
const S = { type: "string" } as const;
const I = { type: "integer" } as const;
const B = { type: "boolean" } as const;

export const TOOLS: Tool[] = [
  {
    name: "telemetry_overview",
    description:
      "What is in the local telemetry store: row counts, time range, total cost, and " +
      "which rows came from OTel versus transcripts. Start here.",
    inputSchema: obj(),
    run: (db) => Q.overview(db),
  },
  {
    name: "telemetry_cost",
    description:
      "Spend and token totals grouped by model, day, hour, plugin, skill, agent, " +
      "session, cwd, git_branch, query_source, speed or effort.",
    inputSchema: obj({ group_by: S, since: S, until: S, limit: I }),
    run: (db, a) => Q.cost(db, {
      groupBy: a["group_by"] as string, since: a["since"] as string,
      until: a["until"] as string, limit: a["limit"] as number,
    }),
  },
  {
    name: "telemetry_sessions",
    description: "Recent sessions with cost, tokens, tool-call count, cwd and branch.",
    inputSchema: obj({ since: S, cwd_like: S, session_id: S, limit: I }),
    run: (db, a) => Q.sessions(db, {
      since: a["since"] as string, cwdLike: a["cwd_like"] as string,
      sessionId: a["session_id"] as string, limit: a["limit"] as number,
    }),
  },
  {
    name: "telemetry_tool_audit",
    description:
      "Audit surface: tool calls with success, duration, permission decision and who " +
      "made it. Filter by tool_name, success, decision or time.",
    inputSchema: obj({ tool_name: S, success: B, decision: S, since: S, limit: I,
                       session_id: S, agent_id: S }),
    run: (db, a) => Q.toolAudit(db, {
      toolName: a["tool_name"] as string, success: a["success"] as boolean,
      decision: a["decision"] as string, since: a["since"] as string,
      limit: a["limit"] as number, sessionId: a["session_id"] as string,
      agentId: a["agent_id"] as string,
    }),
  },
  {
    name: "telemetry_traces",
    description:
      "Traces most recent first, with root span name, span count and duration. The " +
      "index to pick a trace_id from before calling telemetry_trace.",
    inputSchema: obj({ since: S, session_id: S, limit: I }),
    run: (db, a) => Q.traces(db, {
      since: a["since"] as string, sessionId: a["session_id"] as string,
      limit: a["limit"] as number,
    }),
  },
  {
    name: "telemetry_trace",
    description:
      "The observability tree for one trace, or the latest trace of a session: nested " +
      "spans with the session's events woven in by time. A session with no spans " +
      "returns its events as a flat tree, which is the normal case unless the beta " +
      "trace exporter is on.",
    inputSchema: obj({ trace_id: S, session_id: S, events: B }),
    run: (db, a) => Q.trace(db, {
      traceId: a["trace_id"] as string, sessionId: a["session_id"] as string,
      includeEvents: a["events"] as boolean,
    }),
  },
  {
    name: "telemetry_run_query",
    description:
      "Group-by and aggregate over any table. calculate: count, sum_cost, sum_input, " +
      "sum_output, sum_cache_read, sum_cache_creation, avg_duration, max_duration, " +
      "sum_duration.",
    inputSchema: obj({ table: S, calculate: S, breakdown: S, where: S, since: S, until: S, limit: I }),
    run: (db, a) => Q.runQuery(db, {
      table: a["table"] as string, calculate: a["calculate"] as string,
      breakdown: a["breakdown"] as string, where: a["where"] as string,
      since: a["since"] as string, until: a["until"] as string, limit: a["limit"] as number,
    }),
  },
  {
    name: "telemetry_workflows",
    description:
      "Workflow runs with the agents they actually spawned, and the measured " +
      "token and dollar cost of those agents.",
    inputSchema: obj({ since: S, session_id: S, limit: I }),
    run: (db, a) => Q.workflows(db, {
      since: a["since"] as string, sessionId: a["session_id"] as string,
      limit: a["limit"] as number,
    }),
  },
  {
    name: "telemetry_workflow",
    description: "One workflow run, broken down by the agents that did the work.",
    inputSchema: obj({ run_id: S }, ["run_id"]),
    run: (db, a) => Q.workflowRun(db, { runId: a["run_id"] as string }),
  },
  {
    name: "telemetry_agents",
    description:
      "Subagent runs with measured cost, from the transcripts each agent wrote. " +
      "Filter by session, team or workflow run. Measured cost exists even for " +
      "backgrounded agents that never reported totals to their caller.",
    inputSchema: obj({ session_id: S, team: S, run_id: S, since: S, limit: I }),
    run: (db, a) => Q.agents(db, {
      sessionId: a["session_id"] as string, teamName: a["team"] as string,
      workflowRunId: a["run_id"] as string, since: a["since"] as string,
      limit: a["limit"] as number,
    }),
  },
  {
    name: "telemetry_teams",
    description: "Named agent teams, their members and what they cost.",
    inputSchema: obj({ since: S, limit: I }),
    run: (db, a) => Q.teams(db, { since: a["since"] as string, limit: a["limit"] as number }),
  },
  {
    name: "telemetry_plugin_costs",
    description:
      "Per-plugin spend, what is blinded by OTel's third-party redaction, and the " +
      "un-redacted skill/agent invocations recovered from transcripts.",
    inputSchema: obj(),
    run: (db) => Q.pluginCosts(db),
  },
  {
    name: "telemetry_hook_health",
    description:
      "Whether hooks are actually running. A hook erroring is a non-blocking error, so " +
      "the guarded tool call proceeds and nothing looks wrong — this is the only way " +
      "to see it.",
    inputSchema: obj({ since: S, limit: I }),
    run: (db, a) => Q.hookHealth(db, { since: a["since"] as string, limit: a["limit"] as number }),
  },
  {
    name: "telemetry_sql",
    description: "Read-only SELECT against the store. Rejects anything else.",
    inputSchema: obj({ query: S, limit: I }, ["query"]),
    run: (db, a) => Q.sql(db, { query: a["query"] as string, limit: a["limit"] as number }),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function dispatch(msg: Record<string, unknown>, dbPath?: string): Record<string, unknown> | null {
  const id = msg["id"];
  const method = msg["method"];

  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id, result: {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "claude-local-telemetry", version: "0.1.0" },
      },
    };
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0", id, result: {
        tools: TOOLS.map((t) => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
        })),
      },
    };
  }
  if (method === "tools/call") {
    const params = (msg["params"] ?? {}) as Record<string, unknown>;
    const tool = BY_NAME.get(params["name"] as string);
    if (!tool) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${String(params["name"])}` } };
    }
    try {
      const db = openForRead(dbPath);
      let out: unknown;
      try { out = tool.run(db, (params["arguments"] ?? {}) as Record<string, unknown>); }
      finally { db.close(); }
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } };
    } catch (err) {
      return {
        jsonrpc: "2.0", id, result: {
          content: [{ type: "text", text: `error: ${(err as Error).message}` }], isError: true,
        },
      };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${String(method)}` } };
}

export function serve(dbPath?: string): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(t) as Record<string, unknown>; } catch { return; }
    const reply = dispatch(msg, dbPath);
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}
