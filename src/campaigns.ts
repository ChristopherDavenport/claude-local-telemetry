/**
 * Derive campaigns from sessions that already happened.
 *
 * The unit of work this measures is not a ticket. Measured over 27 days on the
 * store this was written against: 80% of sessions ran on `HEAD` or `main`, and
 * not one branch name was ticket-shaped. A ledger keyed on a ticket would have
 * been empty. What is actually there is a *campaign* — several sessions across
 * several repositories over several days, sharing one purpose — and every input
 * needed to reconstruct one is recorded as a side effect of working.
 *
 * So nothing here is entered by hand. Two signals do the work:
 *
 *   - which projects a session touched, from `api_requests.cwd`
 *   - when it ran, from `sessions.started_at` / `ended_at`
 *
 * Sessions sharing a project close together in time are the same campaign,
 * transitively. That is a union-find over a graph whose edges are "same project,
 * less than `windowHours` apart".
 *
 * Two things make the naive version wrong
 * ---------------------------------------
 * **Scratch directories link everything.** `/private/tmp` appeared in 10
 * distinct sessions in the source data — unrelated work that happened to use a
 * temp dir. Treating that as a shared project merges all of it into one
 * meaningless blob. Ephemeral paths are therefore not projects at all.
 *
 * **A cwd is not a project.** `/repo` and `/repo/sub` are one thing; two clones
 * of one repository under different parents are also one thing. Resolving to
 * the git remote where there is one, and the work-tree root otherwise, merges
 * both cases. The resolution is cached in `projects` because it shells out to
 * git once per distinct directory.
 */

import type { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir, homedir } from "node:os";

export interface DeriveOptions {
  /** Max gap between two sessions on the same project for them to link. */
  windowHours?: number;
  /** A period this long with no session at all ends a campaign. */
  quietHours?: number;
  /** Re-resolve every cwd instead of trusting the `projects` cache. */
  refreshProjects?: boolean;
  now?: string;
}

export interface DeriveResult {
  campaigns: number;
  sessions: number;
  projectsResolved: number;
  ephemeralSkipped: number;
  unattributed: number;
}

/** Paths that are shared scratch rather than anybody's project. */
function isEphemeral(cwd: string): boolean {
  const tmp = tmpdir();
  return (
    cwd === "/tmp" || cwd.startsWith("/tmp/") ||
    cwd === "/private/tmp" || cwd.startsWith("/private/tmp/") ||
    cwd.startsWith("/var/folders/") || cwd.startsWith("/private/var/folders/") ||
    cwd === tmp || cwd.startsWith(tmp.endsWith("/") ? tmp : tmp + "/")
  );
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).trim() || null;
  } catch { return null; }
}

/**
 * Normalise a remote so the same repository reached over ssh and https, with
 * or without a `.git` suffix, is one key.
 */
function normaliseRemote(url: string): string {
  let s = url.trim().replace(/\.git$/, "");
  s = s.replace(/^git@([^:]+):/, "$1/");
  s = s.replace(/^ssh:\/\/git@/, "").replace(/^https?:\/\//, "");
  return s.toLowerCase();
}

/** Resolve a directory that exists, or null if it is not in a repository. */
function repoKeyOf(dir: string): { key: string; kind: string } | null {
  const remote = git(dir, ["remote", "get-url", "origin"]);
  if (remote) return { key: normaliseRemote(remote), kind: "remote" };

  // --git-common-dir, not --show-toplevel. A linked worktree IS its own top
  // level, so --show-toplevel files every agent worktree as a separate project:
  // one campaign in the source data came out as 57 "projects", nearly all of
  // them worktrees of a single repo. The common dir is shared with the main
  // checkout, so its parent is the repository either way.
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common) return { key: dirname(common), kind: "toplevel" };

  return null;
}

export function resolveProject(cwd: string): { key: string | null; kind: string } {
  if (!cwd) return { key: null, kind: "path" };
  if (isEphemeral(cwd)) return { key: null, kind: "ephemeral" };

  if (existsSync(cwd)) {
    const hit = repoKeyOf(cwd);
    if (hit) return hit;
    return { key: cwd, kind: "path" };
  }

  // The directory is gone -- a cleaned-up worktree, a deleted scratch checkout.
  // Walk up for a surviving ancestor, but accept it ONLY if it is a repository.
  // Falling back to any existing ancestor would collapse every deleted
  // subdirectory into whatever shared parent happens to remain, inventing a hub
  // that links unrelated work. A repo ancestor is a real answer; a bare parent
  // directory is a guess.
  let dir = dirname(cwd);
  const stop = homedir();
  while (dir !== "/" && dir !== "." && dir.startsWith(stop) && dir !== stop) {
    if (existsSync(dir)) {
      const hit = repoKeyOf(dir);
      if (hit) return { key: hit.key, kind: hit.kind };
      break;
    }
    dir = dirname(dir);
  }
  return { key: cwd, kind: "path" };
}

/** cwd -> project key, reading and filling the `projects` cache. */
function projectMap(
  db: DatabaseSync, cwds: string[], refresh: boolean, now: string,
): { map: Map<string, string | null>; kindOf: Map<string, string>;
     resolved: number; ephemeral: number } {
  const cached = new Map<string, { key: string | null; kind: string }>();
  if (!refresh) {
    for (const r of db.prepare("SELECT cwd, project_key, kind FROM projects").all() as
      Array<{ cwd: string; project_key: string | null; kind: string }>) {
      cached.set(r.cwd, { key: r.project_key, kind: r.kind });
    }
  }

  const insert = db.prepare(
    "INSERT INTO projects(cwd, project_key, kind, resolved_at) VALUES(?,?,?,?) " +
    "ON CONFLICT(cwd) DO UPDATE SET project_key=excluded.project_key, " +
    "kind=excluded.kind, resolved_at=excluded.resolved_at",
  );

  const map = new Map<string, string | null>();
  const kindOf = new Map<string, string>();
  let resolved = 0, ephemeral = 0;
  for (const cwd of cwds) {
    let hit = cached.get(cwd);
    if (!hit) {
      hit = resolveProject(cwd);
      insert.run(cwd, hit.key, hit.kind, now);
      resolved++;
    }
    if (hit.kind === "ephemeral") ephemeral++;
    map.set(cwd, hit.key);
    // A key can be reached from several cwds; "remote" beats a bare "path" so
    // one unresolvable route does not demote a repository into a container.
    if (hit.key && (!kindOf.has(hit.key) || kindOf.get(hit.key) === "path")) {
      kindOf.set(hit.key, hit.kind);
    }
  }
  return { map, kindOf, resolved, ephemeral };
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let r = this.parent.get(x) ?? x;
    if (r === x) { this.parent.set(x, x); return x; }
    r = this.find(r);
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function derive(db: DatabaseSync, opts: DeriveOptions = {}): DeriveResult {
  const windowMs = (opts.windowHours ?? 72) * 3600_000;
  const now = opts.now ?? new Date().toISOString();

  const sessions = db.prepare(
    "SELECT session_id, started_at, ended_at FROM sessions " +
    "WHERE started_at IS NOT NULL ORDER BY started_at",
  ).all() as Array<{ session_id: string; started_at: string; ended_at: string | null }>;

  const cwdRows = db.prepare(
    "SELECT DISTINCT session_id, cwd FROM api_requests " +
    "WHERE cwd IS NOT NULL AND session_id IS NOT NULL",
  ).all() as Array<{ session_id: string; cwd: string }>;

  const distinctCwds = [...new Set(cwdRows.map((r) => r.cwd))];
  const { map: proj, kindOf, resolved, ephemeral } = projectMap(
    db, distinctCwds, opts.refreshProjects ?? false, now,
  );

  // Drop container directories: a non-repo path that is an ancestor of another
  // project. `~/Documents/Work` is where several unrelated repositories live
  // and is occasionally a cwd in its own right; treating it as a project linked
  // poweron tooling, ACH research and a core-system checkout into one 27-session
  // campaign. A repository stays even if it contains others -- being a real
  // project is the thing that earns the edge, and this is decided from the data
  // rather than from a frequency threshold that would also swallow a busy repo.
  const allKeys = new Set<string>();
  for (const cwd of distinctCwds) { const k = proj.get(cwd); if (k) allKeys.add(k); }
  const containers = new Set<string>();
  for (const k of allKeys) {
    if (kindOf.get(k) !== "path") continue;
    const prefix = k.endsWith("/") ? k : k + "/";
    for (const other of allKeys) {
      if (other !== k && other.startsWith(prefix)) { containers.add(k); break; }
    }
  }

  const byProject = new Map<string, string[]>();
  const sessionProjects = new Map<string, Set<string>>();
  for (const { session_id, cwd } of cwdRows) {
    const key = proj.get(cwd);
    if (!key) continue;                                        // ephemeral, or no cwd
    // A container still says where the session happened, so it counts for
    // attribution -- dropping it outright moved 38 real sessions into
    // "unattributed", which understates coverage as badly as a false link
    // overstates it. What it does not get is an edge.
    (sessionProjects.get(session_id) ?? sessionProjects.set(session_id, new Set()).get(session_id)!).add(key);
    if (containers.has(key)) continue;
    (byProject.get(key) ?? byProject.set(key, []).get(key)!).push(session_id);
  }

  const span = new Map<string, { start: number; end: number }>();
  for (const s of sessions) {
    const start = Date.parse(s.started_at);
    const end = Date.parse(s.ended_at ?? s.started_at);
    if (Number.isNaN(start)) continue;
    span.set(s.session_id, { start, end: Number.isNaN(end) ? start : end });
  }

  // Link consecutive sessions on a project when the gap is under the window.
  // Sorting first makes this linear per project and gives the same connected
  // components as comparing every pair: linking is transitive, so a chain of
  // short gaps is one campaign even when its ends are weeks apart. That is the
  // intended reading of "sustained work on a thing", not a bug.
  const uf = new UnionFind();
  for (const s of sessions) uf.find(s.session_id);
  for (const [, ids] of byProject) {
    const ordered = [...new Set(ids)]
      .filter((id) => span.has(id))
      .sort((a, b) => span.get(a)!.start - span.get(b)!.start);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!, cur = ordered[i]!;
      if (span.get(cur)!.start - span.get(prev)!.end <= windowMs) uf.union(prev, cur);
    }
  }

  // Only sessions that touched a real project can be attributed. A session with
  // no cwd, or only scratch, is counted and reported rather than silently
  // dropped -- a ledger that quietly ignores part of its input overstates its
  // own coverage.
  const rawClusters = new Map<string, string[]>();
  let unattributed = 0;
  for (const s of sessions) {
    if (!sessionProjects.has(s.session_id)) { unattributed++; continue; }
    const root = uf.find(s.session_id);
    (rawClusters.get(root) ?? rawClusters.set(root, []).get(root)!).push(s.session_id);
  }

  // Split a cluster wherever nothing at all happened for `quietHours`.
  //
  // Linking is transitive, so continuous work across overlapping repositories
  // never breaks on its own: one cluster in the source data ran to 76 sessions
  // across three days because a shared repository chained three days of work
  // together. Its gap profile was unambiguous -- two gaps over six hours, both
  // overnight, and nothing else above two. A period with no session in it is
  // the one boundary the data offers without inventing a threshold.
  //
  // This splits on *when*, which is not the same as splitting on *purpose*. Two
  // unrelated efforts running the same afternoon and touching one repository in
  // common still land together. That needs edge weighting or community
  // detection, and is deliberately not attempted here.
  const quietMs = (opts.quietHours ?? 8) * 3600_000;
  const clusters: string[][] = [];
  for (const ids of rawClusters.values()) {
    const ordered = ids.slice().sort((a, b) => span.get(a)!.start - span.get(b)!.start);
    let run: string[] = [];
    let high = -Infinity;
    for (const id of ordered) {
      const { start, end } = span.get(id)!;
      if (run.length && start - high > quietMs) { clusters.push(run); run = []; }
      run.push(id);
      high = Math.max(high, end);
    }
    if (run.length) clusters.push(run);
  }

  const priorLabels = new Map<string, string>();
  for (const r of db.prepare("SELECT campaign_id, label FROM campaigns WHERE label IS NOT NULL")
    .all() as Array<{ campaign_id: string; label: string }>) {
    priorLabels.set(r.campaign_id, r.label);
  }

  const usage = new Map<string, { i: number; o: number; c: number | null }>();
  for (const r of db.prepare(
    "SELECT session_id, SUM(COALESCE(input_tokens,0)) i, SUM(COALESCE(output_tokens,0)) o, " +
    "SUM(cost_usd) c FROM api_requests WHERE session_id IS NOT NULL GROUP BY session_id",
  ).all() as Array<{ session_id: string; i: number; o: number; c: number | null }>) {
    usage.set(r.session_id, { i: r.i, o: r.o, c: r.c });
  }

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM campaign_sessions");
    db.exec("DELETE FROM campaign_projects");
    db.exec("DELETE FROM campaigns");

    const insCamp = db.prepare(
      "INSERT INTO campaigns(campaign_id,label,started_at,ended_at,session_count," +
      "project_count,input_tokens,output_tokens,cost_usd,derived_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    const insSess = db.prepare("INSERT INTO campaign_sessions(campaign_id,session_id) VALUES(?,?)");
    const insProj = db.prepare(
      "INSERT OR IGNORE INTO campaign_projects(campaign_id,project_key) VALUES(?,?)");

    for (const ids of clusters) {
      ids.sort((a, b) => span.get(a)!.start - span.get(b)!.start);
      const id = ids[0]!;                                    // earliest session
      const projects = new Set<string>();
      let inTok = 0, outTok = 0, cost = 0, sawCost = false;
      for (const sid of ids) {
        for (const k of sessionProjects.get(sid) ?? []) projects.add(k);
        const u = usage.get(sid);
        if (u) {
          inTok += u.i; outTok += u.o;
          if (u.c !== null) { cost += u.c; sawCost = true; }
        }
      }
      insCamp.run(
        id, priorLabels.get(id) ?? null,
        new Date(Math.min(...ids.map((s) => span.get(s)!.start))).toISOString(),
        new Date(Math.max(...ids.map((s) => span.get(s)!.end))).toISOString(),
        ids.length, projects.size, inTok, outTok, sawCost ? cost : null, now,
      );
      for (const sid of ids) insSess.run(id, sid);
      for (const k of projects) insProj.run(id, k);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }

  return {
    campaigns: clusters.length,
    sessions: sessions.length - unattributed,
    projectsResolved: resolved,
    ephemeralSkipped: ephemeral,
    unattributed,
  };
}
