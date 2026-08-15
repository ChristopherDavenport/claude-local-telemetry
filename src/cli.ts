#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/**
 * Single entry point.
 *
 *   claude-local-telemetry backfill [--root DIR] [--since ISO] [--dry-run]
 *   claude-local-telemetry sink     [--port 4318]
 *   claude-local-telemetry api      [--port 4319] [--ui DIR]
 *   claude-local-telemetry mcp
 *   claude-local-telemetry stats
 *   claude-local-telemetry init
 *
 * The shebang suppresses node:sqlite's ExperimentalWarning. That is cosmetic for
 * every subcommand except `mcp`, where the client reads stdio and unexpected
 * output is a protocol problem — the warning goes to stderr, but suppressing it
 * everywhere keeps the behaviour uniform rather than subtly mode-dependent.
 */

import { init, stats, openForRead, defaultDbPath } from "./store.ts";
import { backfill } from "./backfill.ts";
import { startSink } from "./sink.ts";
import { startApi } from "./api.ts";
import { serve as serveMcp } from "./mcp.ts";

function parse(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

const USAGE = `claude-local-telemetry <command>

  backfill   import ~/.claude/projects transcripts   [--root DIR --since ISO --dry-run --quiet]
  sink       receive OTLP from live sessions         [--host --port 4318 --verbose]
  api        HTTP API for the dashboard              [--host --port 4319 --ui DIR]
  mcp        MCP server over stdio
  stats      what is in the store
  init       create or migrate the database

  --db PATH  override the store location (default: ${defaultDbPath()})
`;

function main(): number {
  const { flags, rest } = parse(process.argv.slice(2));
  const cmd = rest[0];
  const db = typeof flags["db"] === "string" ? flags["db"] : undefined;

  switch (cmd) {
    case "init": {
      init(db).close();
      process.stdout.write(`initialised ${db ?? defaultDbPath()}\n`);
      return 0;
    }
    case "stats": {
      const conn = openForRead(db);
      const s = stats(conn);
      for (const [k, v] of Object.entries(s.rows)) {
        process.stdout.write(`  ${k.padEnd(16)}${String(v).padStart(10)}\n`);
      }
      process.stdout.write(`\n  range     ${s.range.from ?? "—"}  ..  ${s.range.to ?? "—"}\n`);
      process.stdout.write(`  cost      $${s.totalCostUsd.toFixed(4)}\n`);
      process.stdout.write(`  by source ${JSON.stringify(s.bySource)}\n`);
      conn.close();
      return 0;
    }
    case "backfill": {
      const r = backfill({
        ...(typeof flags["root"] === "string" ? { root: flags["root"] } : {}),
        ...(db ? { db } : {}),
        ...(typeof flags["since"] === "string" ? { since: flags["since"] } : {}),
        dryRun: flags["dry-run"] === true,
        quiet: flags["quiet"] === true,
      });
      process.stdout.write(
        `${flags["dry-run"] ? "would import" : "imported"} from ${r.files} transcripts:\n` +
        `  api_requests  ${String(r.api).padStart(8)}\n` +
        `  tool_calls    ${String(r.tools).padStart(8)}\n` +
        `  sessions      ${String(r.sessions).padStart(8)}\n` +
        `  skill/agent   ${String(r.skills).padStart(8)}\n`);
      return 0;
    }
    case "sink": {
      startSink({
        ...(typeof flags["host"] === "string" ? { host: flags["host"] } : {}),
        ...(flags["port"] ? { port: Number(flags["port"]) } : {}),
        ...(db ? { db } : {}),
        verbose: flags["verbose"] === true,
      });
      return -1; // long-running
    }
    case "api": {
      startApi({
        ...(typeof flags["host"] === "string" ? { host: flags["host"] } : {}),
        ...(flags["port"] ? { port: Number(flags["port"]) } : {}),
        ...(db ? { db } : {}),
        ...(typeof flags["ui"] === "string" ? { uiDir: flags["ui"] } : {}),
      });
      return -1;
    }
    case "mcp": {
      serveMcp(db);
      return -1;
    }
    default:
      process.stdout.write(USAGE);
      return cmd ? 1 : 0;
  }
}

const code = main();
if (code >= 0) process.exit(code);
