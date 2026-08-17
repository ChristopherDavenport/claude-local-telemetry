/**
 * Give each campaign a name a human recognises.
 *
 * A derived campaign is identified by the id of its earliest session, which is
 * a UUID. Everything else about it is quantitative — dates, projects, sessions,
 * dollars — so the ledger can tell you that `c5086bae` cost $312 and shipped,
 * and nothing about what it was. The label closes that gap and is the only
 * part of the pipeline that needs a model.
 *
 * The material is the operator's own opening asks
 * -----------------------------------------------
 * `sessions.first_prompt` holds what was actually typed at the start of each
 * session. That is the strongest available signal for purpose and it costs
 * nothing to collect — labelling from project names alone would be paying a
 * model to rephrase a directory listing.
 *
 * Shelling out to `claude`, not adding an SDK
 * -------------------------------------------
 * This package has no runtime dependencies and that is a property worth
 * keeping, so the model call goes through the `claude` CLI rather than the
 * Anthropic SDK. It also inherits whatever credentials already work on this
 * machine, which matters when the operator authenticates through a cloud
 * provider rather than an API key.
 *
 * Batched, because the round trip dominates. Twelve campaigns per call turns a
 * hundred-plus process spawns into single digits.
 *
 * What this call inherits, and cannot currently shed
 * --------------------------------------------------
 * Shelling out buys the credentials but takes the whole ambient environment
 * with them. This function is implicitly parameterised by things outside the
 * package, and all of the following were measured rather than assumed:
 *
 *   - **The model.** `--model` pins it, and doing so is load-bearing: without
 *     the flag the call inherits the operator's configured default, which on
 *     the machine this was written against is an Opus tier at five times the
 *     price of the Haiku this asks for.
 *   - **Skills and plugins.** A nested call is shown ~58 skills from whatever
 *     the operator has enabled. `--settings '{"enabledPlugins":{}}'` does NOT
 *     strip them -- tested, same count with and without -- so a naming call
 *     carries the operator's entire plugin surface as context. `--bare` does
 *     strip it (58 -> 3), but changes behaviour enough that this prompt stops
 *     returning JSON, so adopting it needs prompt work and re-validation.
 *   - **The working directory.** CLAUDE.md discovery is cwd-relative, so a
 *     naming run started in a repository that ships one feeds it to the model.
 *   - **Hooks.** The operator's PreToolUse and Stop hooks fire on these calls.
 *
 * And the call is not reproducible in the first place: the same batch can
 * return different names on two runs. Nothing here is deterministic, and
 * nothing downstream should assume it is. That is the opposite of
 * `communities.ts`, whose *label propagation* is a pure graph algorithm made
 * deterministic on purpose -- an unfortunate collision of the word "label"
 * between a Raghavan-style community algorithm and naming a campaign.
 *
 * The mitigation is attribution rather than isolation: `campaigns.label_model`
 * records which model produced each name, so a label can at least be traced to
 * the thing that wrote it.
 */

import type { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";

export interface LabelOptions {
  /** Re-label campaigns that already have one. */
  relabel?: boolean;
  /** Campaigns per model call. */
  batchSize?: number;
  model?: string;
  /** Stop after this many calls. Bounds spend on a first run. */
  maxBatches?: number;
}

export interface LabelResult {
  considered: number;
  labelled: number;
  batches: number;
  skippedNoMaterial: number;
  failures: string[];
}

interface Candidate {
  id: string;
  started: string;
  ended: string;
  sessions: number;
  projects: string[];
  prompts: string[];
}

export function cliAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch { return false; }
}

/** Short, recognisable project names — a full git remote is mostly noise here. */
function shortProject(key: string): string {
  return key.replace(/\/$/, "").split("/").pop() || key;
}

export function candidates(db: DatabaseSync, relabel: boolean): Candidate[] {
  const rows = db.prepare(
    "SELECT campaign_id, started_at, ended_at, session_count FROM campaigns " +
    (relabel ? "" : "WHERE label IS NULL ") + "ORDER BY started_at DESC",
  ).all() as Array<{
    campaign_id: string; started_at: string; ended_at: string; session_count: number;
  }>;

  const projStmt = db.prepare(
    "SELECT project_key FROM campaign_projects WHERE campaign_id=?");
  // Longest prompts first: a one-line "continue" says less about the work than
  // the turn that set it up, and the cap means the choice matters.
  const promptStmt = db.prepare(
    "SELECT s.first_prompt p FROM campaign_sessions cs JOIN sessions s USING(session_id) " +
    "WHERE cs.campaign_id=? AND s.first_prompt IS NOT NULL " +
    "ORDER BY LENGTH(s.first_prompt) DESC LIMIT 4");

  return rows.map((r) => ({
    id: r.campaign_id,
    started: r.started_at.slice(0, 10),
    ended: r.ended_at.slice(0, 10),
    sessions: r.session_count,
    projects: (projStmt.all(r.campaign_id) as Array<{ project_key: string }>)
      .map((x) => shortProject(x.project_key)).slice(0, 6),
    prompts: (promptStmt.all(r.campaign_id) as Array<{ p: string }>)
      .map((x) => x.p.replace(/\s+/g, " ").slice(0, 300)),
  }));
}

const INSTRUCTION = `You are naming units of work for an engineering ledger.

For each campaign below you get its date range, the repositories it touched, and
the opening request of some of its sessions. Return the work's name.

Rules:
- 3 to 8 words, a noun phrase. "Publish plugin context costs", not "The user
  wanted to publish costs".
- Name the work, not the tooling used to do it, and not the session count.
- Use the repository names only when the prompts do not say what the work was.
- If the prompts are too thin to tell, use the repository names and say what
  kind of work it plainly is.

Return ONLY a JSON array, no prose and no code fence:
[{"id":"<campaign id verbatim>","label":"<name>"}]`;

function callModel(payload: string, model: string): string {
  return execFileSync(
    "claude",
    ["--print", "--model", model, "--permission-mode", "auto", "--strict-mcp-config"],
    { input: payload, encoding: "utf8", timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
  );
}

/**
 * Pull the JSON array out of a model response.
 *
 * Asking for bare JSON is not the same as getting it — a fence or a sentence of
 * preamble is a normal response, and treating that as a failure would throw
 * away a good batch.
 */
export function parseLabels(out: string): Array<{ id: string; label: string }> {
  const start = out.indexOf("[");
  const end = out.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(out.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((e) => {
      const o = e as { id?: unknown; label?: unknown };
      return typeof o?.id === "string" && typeof o?.label === "string" && o.label.trim()
        ? [{ id: o.id, label: o.label.trim().slice(0, 120) }]
        : [];
    });
  } catch { return []; }
}

export function label(db: DatabaseSync, opts: LabelOptions = {}): LabelResult {
  if (!cliAvailable()) {
    // Same rule as the artifact harvest: refusing is better than recording
    // nothing, because an unlabelled campaign and an unlabellable one look
    // identical afterwards.
    throw new Error(
      "the `claude` CLI is not available, so no campaign could be named. " +
      "Refusing to record an empty labelling pass.",
    );
  }

  const batchSize = opts.batchSize ?? 12;
  const model = opts.model ?? "claude-haiku-4-5";
  const all = candidates(db, opts.relabel ?? false);

  // A campaign with no prompt from any of its sessions has nothing but a
  // directory listing behind it. Naming it would be invention, so it is
  // reported instead.
  const usable = all.filter((c) => c.prompts.length > 0);
  const skipped = all.length - usable.length;

  const upd = db.prepare(
    "UPDATE campaigns SET label=?, label_model=? WHERE campaign_id=?");
  const failures: string[] = [];
  let labelled = 0, batches = 0;

  for (let i = 0; i < usable.length; i += batchSize) {
    if (opts.maxBatches !== undefined && batches >= opts.maxBatches) break;
    const chunk = usable.slice(i, i + batchSize);
    batches++;

    let out: string;
    try { out = callModel(`${INSTRUCTION}\n\n${JSON.stringify(chunk, null, 1)}`, model); }
    catch (e) {
      failures.push(`batch ${batches}: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }

    const got = parseLabels(out);
    if (!got.length) { failures.push(`batch ${batches}: no labels parsed from response`); continue; }

    const wanted = new Set(chunk.map((c) => c.id));
    db.exec("BEGIN");
    try {
      for (const { id, label: text } of got) {
        // Only ids we asked about: a hallucinated id must not create a row or
        // overwrite an unrelated campaign.
        if (!wanted.has(id)) continue;
        upd.run(text, model, id);
        labelled++;
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  return {
    considered: all.length, labelled, batches,
    skippedNoMaterial: skipped, failures,
  };
}
