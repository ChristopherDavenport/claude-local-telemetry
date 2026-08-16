/**
 * HTTP API for the dashboard. Same queries the MCP server uses.
 *
 * Loopback only, no auth, read-only — identical posture to the sink, and for the
 * same reason: the store contains prompts and tool inputs.
 *
 * Opens a fresh read-only handle per request rather than holding one. Requests
 * are milliseconds and the sink may be checkpointing WAL underneath; a
 * long-lived reader would pin an old snapshot and quietly serve stale numbers.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { openForRead } from "./store.ts";
import * as Q from "./queries.ts";

type Handler = (params: URLSearchParams) => unknown;

const num = (v: string | null): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const s = (v: string | null): string | undefined => v ?? undefined;

function routes(dbPath?: string): Record<string, Handler> {
  const withDb = <T>(fn: (db: ReturnType<typeof openForRead>) => T) => (): T => {
    const db = openForRead(dbPath);
    try { return fn(db); } finally { db.close(); }
  };
  return {
    "/api/overview": withDb((db) => Q.overview(db)),
    "/api/cost": (p) => withDb((db) => Q.cost(db, {
      groupBy: s(p.get("group_by")), since: s(p.get("since")),
      until: s(p.get("until")), limit: num(p.get("limit")),
      sessionId: s(p.get("session_id")),
    }))(),
    "/api/sessions": (p) => withDb((db) => Q.sessions(db, {
      since: s(p.get("since")), cwdLike: s(p.get("cwd_like")), limit: num(p.get("limit")),
      sessionId: s(p.get("session_id")),
    }))(),
    "/api/tools": (p) => withDb((db) => Q.toolAudit(db, {
      toolName: s(p.get("tool_name")), decision: s(p.get("decision")),
      since: s(p.get("since")), limit: num(p.get("limit")),
      sessionId: s(p.get("session_id")), agentId: s(p.get("agent_id")),
      ...(p.get("success") == null ? {} : { success: p.get("success") === "true" }),
    }))(),
    "/api/traces": (p) => withDb((db) => Q.traces(db, {
      since: s(p.get("since")), sessionId: s(p.get("session_id")), limit: num(p.get("limit")),
    }))(),
    "/api/trace": (p) => withDb((db) => Q.trace(db, {
      traceId: s(p.get("trace_id")), sessionId: s(p.get("session_id")),
      ...(p.get("events") == null ? {} : { includeEvents: p.get("events") !== "false" }),
    }))(),
    "/api/query": (p) => withDb((db) => Q.runQuery(db, {
      table: s(p.get("table")), calculate: s(p.get("calculate")),
      breakdown: s(p.get("breakdown")), where: s(p.get("where")),
      since: s(p.get("since")), until: s(p.get("until")), limit: num(p.get("limit")),
    }))(),
    // The one query surface the MCP server had and this did not. `sql()` applies
    // the same read-only guard for both callers — a single SELECT, no statement
    // separators, no DDL — so routing it here closes the asymmetry rather than
    // opening a new hole.
    "/api/sql": (p) => withDb((db) => Q.sql(db, {
      query: s(p.get("query")), limit: num(p.get("limit")),
    }))(),
    "/api/workflows": (p) => withDb((db) => Q.workflows(db, {
      since: s(p.get("since")), sessionId: s(p.get("session_id")), limit: num(p.get("limit")),
    }))(),
    "/api/workflow": (p) => withDb((db) => Q.workflowRun(db, { runId: s(p.get("run_id")) }))(),
    "/api/agents": (p) => withDb((db) => Q.agents(db, {
      sessionId: s(p.get("session_id")), teamName: s(p.get("team")),
      workflowRunId: s(p.get("run_id")), since: s(p.get("since")), limit: num(p.get("limit")),
    }))(),
    "/api/teams": (p) => withDb((db) => Q.teams(db, {
      since: s(p.get("since")), limit: num(p.get("limit")),
    }))(),
    "/api/plugins": withDb((db) => Q.pluginCosts(db)),
    "/api/hooks": (p) => withDb((db) => Q.hookHealth(db, {
      since: s(p.get("since")), limit: num(p.get("limit")),
    }))(),
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".map": "application/json",
};

export interface ApiOptions {
  host?: string | undefined; port?: number | undefined; db?: string | undefined; uiDir?: string | undefined;
}

export function startApi(opts: ApiOptions = {}) {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4319;
  const table = routes(opts.db);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const send = (code: number, body: string, type = "application/json") => {
      res.writeHead(code, {
        "Content-Type": type,
        "Content-Length": String(Buffer.byteLength(body)),
        // The dashboard is served from this same origin in production; the dev
        // server runs on another port, hence loopback-only CORS.
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
    };

    const handler = table[url.pathname];
    if (handler) {
      try {
        send(200, JSON.stringify(handler(url.searchParams)));
      } catch (err) {
        send(400, JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // Static UI, if a build exists. Path-normalised and confined to uiDir --
    // this serves from a directory on a loopback port, but "only loopback" has
    // never been a reason to allow ../../etc/passwd.
    if (opts.uiDir) {
      const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
      const file = join(opts.uiDir, rel);
      if (file.startsWith(opts.uiDir) && existsSync(file) && statSync(file).isFile()) {
        send(200, readFileSync(file, "utf8"), MIME[extname(file)] ?? "application/octet-stream");
        return;
      }
      const index = join(opts.uiDir, "index.html");
      if (existsSync(index)) { send(200, readFileSync(index, "utf8"), MIME[".html"]!); return; }
    }
    send(404, JSON.stringify({ error: "not found", routes: Object.keys(table) }));
  });

  server.listen(port, host, () => {
    process.stdout.write(`api on http://${host}:${port}\n`);
    process.stdout.write(`  ${Object.keys(table).join("  ")}\n`);
    if (opts.uiDir) process.stdout.write(`  serving ui from ${opts.uiDir}\n`);
  });
  return server;
}
