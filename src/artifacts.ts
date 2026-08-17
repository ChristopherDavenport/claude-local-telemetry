/**
 * Attach what a campaign produced to what it cost.
 *
 * The store answers "what did this cost" precisely and "was it worth it" not at
 * all. Cost is the denominator; this is the numerator. For work whose output is
 * a repository, the numerator is unusually tractable, because an artifact either
 * survives and gets used or it does not, and both are observable without asking
 * anyone to score anything:
 *
 *   merged      the work shipped
 *   closed      it was abandoned -- the expensive, invisible outcome
 *   open        still in flight at harvest time
 *
 * That is deliberately not a judgement. A closed pull request is not a failure
 * and a merged one is not a success; what the pair gives you is the split of
 * spend across shipped, abandoned and in-flight, which is the thing a token
 * ledger structurally cannot show.
 *
 * Attribution is by repository and time window: a pull request created in a
 * repository the campaign touched, between its first session and `graceDays`
 * after its last. That is approximate and knowingly so -- the alternative is
 * asking a human to link them, which is the manual bookkeeping this whole
 * design exists to avoid. `harvested_at` records when the state was observed,
 * because an open pull request is a fact about a moment, not about the work.
 *
 * Requires `gh`, authenticated. If it is missing the harvest reports that and
 * stops rather than recording zero artifacts, which would read as "this
 * campaign produced nothing".
 */

import type { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";

export interface HarvestOptions {
  /**
   * Whose pull requests count. Defaults to the authenticated user.
   *
   * Not optional in practice. Without it a campaign that touched a shared
   * repository for an afternoon absorbs every pull request opened in that
   * repository during its window: measured on a real store, one campaign
   * picked up 155 artifacts from a busy org repo, nearly all of them written
   * by other engineers. That does not merely add noise -- it inflates
   * "shipped" with work the campaign had nothing to do with, which is the one
   * number the ledger exists to get right.
   */
  author?: string;
  /** Days after the last session in which a pull request still counts. */
  graceDays?: number;
  /** Only harvest campaigns that ended on or after this ISO date. */
  since?: string;
  now?: string;
  /**
   * Override how pull requests are fetched. Exists so the counting rules can be
   * tested without `gh`, a network, or a fixture repository -- the row-versus-
   * pull-request distinction below is precisely the kind of arithmetic that
   * regresses without anyone noticing.
   */
  lister?: (repo: string, from: string, to: string, author: string) => PullRequest[];
}

/**
 * Counts come in two flavours, and conflating them overstates output.
 *
 * `artifacts` and its merged/closed/open breakdown count **attribution rows** --
 * one per (campaign, pull request). A pull request created in a repository that
 * two campaigns both touched, inside both their windows, is genuinely claimed by
 * both, so it contributes two rows. That is the intended behaviour of a
 * window-based join and not something to dedupe away at write time.
 *
 * `distinct*` counts **pull requests**. This is the number to divide spend by.
 * Measured on a real store the gap is not marginal -- 65 merged rows against 38
 * merged pull requests, with three campaigns claiming a single PR -- so
 * reporting rows as though they were output inflates the denominator by 1.7x
 * and makes cost per shipped change look correspondingly cheap.
 */
export interface HarvestResult {
  campaigns: number;
  repos: number;
  /** Attribution rows: one per (campaign, pull request). */
  artifacts: number;
  merged: number;
  closed: number;
  open: number;
  /** Distinct pull requests, regardless of how many campaigns claim each. */
  distinctArtifacts: number;
  distinctMerged: number;
  distinctClosed: number;
  distinctOpen: number;
  skipped: string[];
}

export interface PullRequest {
  number: number;
  state: string;
  title: string;
  url: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
}

export function ghAvailable(): boolean {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch { return false; }
}

/** A project key that names a GitHub repository, or null. */
export function repoOf(projectKey: string): string | null {
  const m = /^github\.com\/([^/]+\/[^/]+)$/.exec(projectKey);
  return m ? m[1]! : null;
}

function listPulls(repo: string, from: string, to: string, author: string): PullRequest[] {
  const out = execFileSync("gh", [
    "pr", "list", "--repo", repo, "--author", author, "--state", "all", "--limit", "200",
    "--search", `created:${from.slice(0, 10)}..${to.slice(0, 10)}`,
    "--json", "number,state,title,url,createdAt,mergedAt,closedAt,additions,deletions",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  return JSON.parse(out) as PullRequest[];
}

export function harvest(db: DatabaseSync, opts: HarvestOptions = {}): HarvestResult {
  const now = opts.now ?? new Date().toISOString();
  const author = opts.author ?? "@me";
  const graceMs = (opts.graceDays ?? 7) * 86400_000;
  const skipped: string[] = [];

  const fetchPulls = opts.lister ?? listPulls;

  if (!opts.lister && !ghAvailable()) {
    // Loud, not silent. Recording nothing here is indistinguishable from a
    // campaign that genuinely produced nothing, and that is the more damaging
    // of the two readings.
    throw new Error(
      "gh is unavailable or unauthenticated, so no artifact state could be read. " +
      "Run `gh auth status`. Refusing to record an empty harvest, which would " +
      "read as 'these campaigns shipped nothing'.",
    );
  }

  const campaigns = db.prepare(
    "SELECT campaign_id, started_at, ended_at FROM campaigns " +
    (opts.since ? "WHERE ended_at >= ? " : "") + "ORDER BY started_at",
  ).all(...(opts.since ? [opts.since] : [])) as
    Array<{ campaign_id: string; started_at: string; ended_at: string }>;

  const ins = db.prepare(
    "INSERT OR REPLACE INTO campaign_artifacts(campaign_id,kind,repo,ref,state,title," +
    "created_at,resolved_at,additions,deletions,url,harvested_at) " +
    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );

  // One call per (repo, window) rather than per campaign: several campaigns
  // commonly share a repository, and the API round trip dominates.
  const cache = new Map<string, PullRequest[]>();
  let artifacts = 0, merged = 0, closed = 0, openCount = 0;
  const repos = new Set<string>();
  // repo#number -> state. A pull request has exactly one state however many
  // campaigns claim it, so a map keyed on its identity gives the distinct counts.
  const distinct = new Map<string, string>();

  for (const c of campaigns) {
    const keys = db.prepare("SELECT project_key FROM campaign_projects WHERE campaign_id=?")
      .all(c.campaign_id) as Array<{ project_key: string }>;
    const from = c.started_at;
    const to = new Date(Date.parse(c.ended_at) + graceMs).toISOString();

    for (const { project_key } of keys) {
      const repo = repoOf(project_key);
      if (!repo) continue;                     // a local path is not harvestable
      repos.add(repo);
      const ck = `${repo} ${author} ${from.slice(0, 10)} ${to.slice(0, 10)}`;
      let pulls = cache.get(ck);
      if (!pulls) {
        try { pulls = fetchPulls(repo, from, to, author); }
        catch (e) {
          const msg = `${repo}: ${(e as Error).message.split("\n")[0]}`;
          if (!skipped.includes(msg)) skipped.push(msg);
          pulls = [];
        }
        cache.set(ck, pulls);
      }

      for (const p of pulls) {
        const created = Date.parse(p.createdAt);
        if (created < Date.parse(from) || created > Date.parse(to)) continue;
        const state = p.mergedAt ? "merged" : p.state === "OPEN" ? "open" : "closed";
        ins.run(
          c.campaign_id, "pr", repo, String(p.number), state, p.title,
          p.createdAt, p.mergedAt ?? p.closedAt, p.additions, p.deletions, p.url, now,
        );
        artifacts++;
        distinct.set(`${repo}#${p.number}`, state);
        if (state === "merged") merged++;
        else if (state === "open") openCount++;
        else closed++;
      }
    }
  }

  let dMerged = 0, dClosed = 0, dOpen = 0;
  for (const state of distinct.values()) {
    if (state === "merged") dMerged++;
    else if (state === "open") dOpen++;
    else dClosed++;
  }

  return {
    campaigns: campaigns.length, repos: repos.size,
    artifacts, merged, closed, open: openCount,
    distinctArtifacts: distinct.size,
    distinctMerged: dMerged, distinctClosed: dClosed, distinctOpen: dOpen,
    skipped,
  };
}
