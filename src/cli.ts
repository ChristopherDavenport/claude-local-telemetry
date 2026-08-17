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
 *   claude-local-telemetry alias   [list|derive|set <hash> <name>|rm <hash>]
 *   claude-local-telemetry campaigns [derive [--window-hours N] [--quiet-hours N]
 *                                             [--min-weight W] [--strategy communities]
 *                                             [--refresh-projects]
 *                                    | harvest [--grace-days N] [--since ISO] [--author LOGIN]
 *                                    | price
 *                                    | label [--relabel] [--batch-size N] [--max-batches N] [--model M]
 *                                    | list]
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
import * as Alias from "./alias.ts";
import * as Campaigns from "./campaigns.ts";
import * as Artifacts from "./artifacts.ts";
import * as Pricing from "./pricing.ts";
import * as Labeling from "./labeling.ts";

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

  alias                        map plugin_id_hash to a real name (un-blinds spend)
    alias list
    alias derive               learn mappings where OTel and a transcript agree
    alias set <hash> <name>    record one by hand
    alias rm  <hash>

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
        `  skill/agent   ${String(r.skills).padStart(8)}\n` +
        `  agent_runs    ${String(r.agents).padStart(8)}\n` +
        `  workflow_runs ${String(r.workflows).padStart(8)}\n`);
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
    case "alias": {
      // Writes, so it opens through init() rather than a read-only handle.
      const conn = init(db);
      try {
        const sub = rest[1] ?? "list";
        if (sub === "list") {
          const rows = Alias.list(conn);
          if (!rows.length) {
            process.stdout.write("no aliases yet. Try: alias derive\n");
            return 0;
          }
          for (const r of rows) {
            process.stdout.write(
              `  ${r.plugin_id_hash.padEnd(20)} ${String(r.plugin_name).padEnd(28)} ${r.confidence}\n`);
          }
          return 0;
        }
        if (sub === "derive") {
          const r = Alias.derive(conn);
          const applied = Alias.apply(conn);
          process.stdout.write(
            `learned ${r.learned} mapping(s); ${r.hashesResolved}/${r.hashesSeen} hashes now named\n` +
            `  ${applied} previously blinded requests attributed\n`);
          for (const a of r.ambiguous) {
            process.stdout.write(
              `  ambiguous ${a.plugin_id_hash}: ${a.names.join(" | ")} — settle with \`alias set\`\n`);
          }
          if (!r.hashesSeen) {
            process.stdout.write(
              "  no plugin_id_hash in the store: that only arrives from the OTLP sink.\n");
          }
          return 0;
        }
        if (sub === "set") {
          const [, , hash, name] = rest;
          if (!hash || !name) { process.stdout.write("usage: alias set <hash> <name>\n"); return 1; }
          Alias.set(conn, { hash, name });
          process.stdout.write(`${hash} -> ${name}\n  ${Alias.apply(conn)} requests attributed\n`);
          return 0;
        }
        if (sub === "rm") {
          const hash = rest[2];
          if (!hash) { process.stdout.write("usage: alias rm <hash>\n"); return 1; }
          process.stdout.write(`removed ${Alias.remove(conn, hash)}\n`);
          return 0;
        }
        process.stdout.write(`unknown: alias ${sub}\n`);
        return 1;
      } finally { conn.close(); }
    }
    case "campaigns": {
      const sub = rest[1] ?? "list";
      if (sub === "derive") {
        // Writes, so it takes a read-write handle and runs the schema first --
        // an older store has no campaigns table and init() is idempotent.
        const conn = init(db);
        try {
          const opts: Campaigns.DeriveOptions = {
            refreshProjects: flags["refresh-projects"] === true,
          };
          if (flags["window-hours"]) opts.windowHours = Number(flags["window-hours"]);
          if (flags["quiet-hours"]) opts.quietHours = Number(flags["quiet-hours"]);
          if (flags["min-weight"]) opts.minWeight = Number(flags["min-weight"]);
          if (flags["strategy"] === "communities") opts.strategy = "communities";
          const r = Campaigns.derive(conn, opts);
          process.stdout.write(
            `  campaigns      ${String(r.campaigns).padStart(6)}\n` +
            `  edges          ${String(r.edges).padStart(6)}\n` +
            (r.modularity !== null
              ? `  modularity     ${r.modularity.toFixed(3).padStart(6)}  (Q; >0.3 is real structure)\n`
              : "") +
            `  sessions       ${String(r.sessions).padStart(6)}\n` +
            `  projects new   ${String(r.projectsResolved).padStart(6)}\n` +
            `  ephemeral cwds ${String(r.ephemeralSkipped).padStart(6)}  (not linked)\n` +
            `  unattributed   ${String(r.unattributed).padStart(6)}  (no project touched)\n`,
          );
        } finally { conn.close(); }
        return 0;
      }
      if (sub === "label") {
        const conn = init(db);
        try {
          const o: Labeling.LabelOptions = { relabel: flags["relabel"] === true };
          if (flags["batch-size"]) o.batchSize = Number(flags["batch-size"]);
          if (flags["max-batches"]) o.maxBatches = Number(flags["max-batches"]);
          if (typeof flags["model"] === "string") o.model = flags["model"];
          const r = Labeling.label(conn, o);
          process.stdout.write(
            `  considered     ${String(r.considered).padStart(6)}\n` +
            `  labelled       ${String(r.labelled).padStart(6)}\n` +
            `  batches        ${String(r.batches).padStart(6)}  model calls\n` +
            `  no material    ${String(r.skippedNoMaterial).padStart(6)}  no prompt on any session\n`);
          for (const f of r.failures) process.stdout.write(`  failed: ${f}\n`);
        } finally { conn.close(); }
        return 0;
      }
      if (sub === "price") {
        const conn = init(db);
        try {
          const r = Pricing.price(conn);
          process.stdout.write(
            `  priced         ${String(r.priced).padStart(6)}  rows given cost_est_usd\n` +
            `  measured       ${String(r.alreadyMeasured).padStart(6)}  rows that already had cost_usd\n` +
            `  unpriceable    ${String(r.unpriceable).padStart(6)}  no rate for the model\n` +
            `  estimated      $${r.estimatedUsd.toFixed(2)}\n` +
            `  measured       $${r.measuredUsd.toFixed(2)}  (provider-reported, for comparison)\n` +
            `  rates taken    ${Pricing.RATES_TAKEN}, first-party list\n`);
          for (const m of r.unknownModels) process.stdout.write(`  no rate: ${m}\n`);
        } finally { conn.close(); }
        return 0;
      }
      if (sub === "harvest") {
        const conn = init(db);
        try {
          const o: Artifacts.HarvestOptions = {};
          if (flags["grace-days"]) o.graceDays = Number(flags["grace-days"]);
          if (typeof flags["since"] === "string") o.since = flags["since"];
          if (typeof flags["author"] === "string") o.author = flags["author"];
          const r = Artifacts.harvest(conn, o);
          const dup = r.artifacts - r.distinctArtifacts;
          process.stdout.write(
            `  campaigns      ${String(r.campaigns).padStart(6)}\n` +
            `  repos          ${String(r.repos).padStart(6)}\n` +
            `  pull requests  ${String(r.distinctArtifacts).padStart(6)}  distinct\n` +
            `    merged       ${String(r.distinctMerged).padStart(6)}\n` +
            `    closed       ${String(r.distinctClosed).padStart(6)}  (abandoned)\n` +
            `    open         ${String(r.distinctOpen).padStart(6)}\n` +
            `  attributions   ${String(r.artifacts).padStart(6)}  rows, one per (campaign, PR)\n`);
          if (dup > 0) {
            process.stdout.write(
              `  ${String(dup).padStart(15)}  of those are the same PR claimed by more than one\n` +
              `                   campaign. Divide spend by the distinct count, not this one.\n`);
          }
          for (const s2 of r.skipped) process.stdout.write(`  skipped ${s2}\n`);
        } finally { conn.close(); }
        return 0;
      }
      if (sub === "list") {
        const conn = openForRead(db);
        try {
          const rows = conn.prepare(
            "SELECT campaign_id, label, started_at, ended_at, session_count, " +
            "project_count, input_tokens, output_tokens, cost_usd FROM campaigns " +
            "ORDER BY started_at DESC",
          ).all() as Array<Record<string, unknown>>;
          for (const r of rows) {
            const days = Math.max(1, Math.round(
              (Date.parse(String(r["ended_at"])) - Date.parse(String(r["started_at"]))) / 86400000));
            process.stdout.write(
              `  ${String(r["started_at"]).slice(0, 10)}  ${String(days).padStart(2)}d  ` +
              `${String(r["session_count"]).padStart(3)}s  ` +
              `${String(r["project_count"]).padStart(2)}p  ` +
              `${(Number(r["output_tokens"]) / 1000).toFixed(0).padStart(6)}k out  ` +
              `${r["label"] ?? String(r["campaign_id"]).slice(0, 8)}\n`,
            );
          }
          process.stdout.write(`\n  ${rows.length} campaigns\n`);
        } finally { conn.close(); }
        return 0;
      }
      process.stdout.write(`unknown: campaigns ${sub}\n`);
      return 1;
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
