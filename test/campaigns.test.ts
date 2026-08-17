/**
 * Assertion tests for campaign derivation.
 *
 * Synthetic sessions throughout, for the same reason the store tests are: the
 * behaviour worth pinning is the clustering rules, and real cwds differ per
 * machine. Every case here is one that got the first implementation wrong on
 * real data.
 *
 * No model, no network, no git repository required — the cases that would need
 * one exercise `resolveProject` against paths that do not exist, which is the
 * branch that matters anyway.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { init } from "../src/store.ts";
import { derive, resolveProject } from "../src/campaigns.ts";
import { repoOf } from "../src/artifacts.ts";

let work: string;
let db: DatabaseSync;

before(() => { work = mkdtempSync(join(tmpdir(), "clt-camp-")); });
after(() => { try { db?.close(); } catch { /* already closed */ } rmSync(work, { recursive: true, force: true }); });

/** Sessions are cheap to fabricate; the clustering is what is under test. */
function seed(rows: Array<{ id: string; start: string; end?: string; cwds: string[] }>): DatabaseSync {
  const path = join(work, `${Math.random().toString(36).slice(2)}.db`);
  const conn = init(path);
  const s = conn.prepare(
    "INSERT INTO sessions(session_id,started_at,ended_at,source) VALUES(?,?,?,'test')");
  const a = conn.prepare(
    "INSERT INTO api_requests(request_id,ts,session_id,cwd,input_tokens,output_tokens,source) " +
    "VALUES(?,?,?,?,10,20,'test')");
  let n = 0;
  for (const r of rows) {
    s.run(r.id, r.start, r.end ?? r.start);
    for (const cwd of r.cwds) a.run(`req-${n++}`, r.start, r.id, cwd);
  }
  return conn;
}

const H = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();

test("sessions sharing a project inside the window are one campaign", () => {
  db = seed([
    { id: "s1", start: H(0), end: H(1), cwds: ["/proj/a"] },
    { id: "s2", start: H(2), end: H(3), cwds: ["/proj/a"] },
  ]);
  const r = derive(db, { quietHours: 8 });
  assert.equal(r.campaigns, 1);
  assert.equal(r.sessions, 2);
  db.close();
});

test("a quiet period ends a campaign even though the project is shared", () => {
  // The failure this pins: linking is transitive, so continuous work on one
  // repository never split on its own. A real cluster reached 76 sessions.
  db = seed([
    { id: "s1", start: H(0), end: H(1), cwds: ["/proj/a"] },
    { id: "s2", start: H(20), end: H(21), cwds: ["/proj/a"] },
  ]);
  const r = derive(db, { quietHours: 8 });
  assert.equal(r.campaigns, 2, "19h of silence should be a boundary");
  db.close();
});

test("scratch directories do not link unrelated work", () => {
  // /private/tmp appeared in 10 distinct sessions on the source machine.
  db = seed([
    { id: "s1", start: H(0), end: H(1), cwds: ["/proj/a", "/private/tmp/x"] },
    { id: "s2", start: H(2), end: H(3), cwds: ["/proj/b", "/private/tmp/y"] },
  ]);
  const r = derive(db, { quietHours: 8 });
  assert.equal(r.campaigns, 2, "a shared temp dir is not shared work");
  assert.ok(r.ephemeralSkipped >= 2);
  db.close();
});

test("a non-repo parent of other projects is context, not an edge", () => {
  // ~/Documents/Work linked poweron tooling, ACH research and a core checkout
  // into one 27-session campaign before this rule existed.
  db = seed([
    { id: "s1", start: H(0), end: H(1), cwds: ["/work", "/work/a"] },
    { id: "s2", start: H(2), end: H(3), cwds: ["/work", "/work/b"] },
  ]);
  const r = derive(db, { quietHours: 8 });
  assert.equal(r.campaigns, 2, "a container directory must not create an edge");
  assert.equal(r.sessions, 2, "but the sessions are still attributed, not dropped");
  db.close();
});

test("a session touching no project is reported rather than silently dropped", () => {
  db = seed([
    { id: "s1", start: H(0), end: H(1), cwds: ["/private/tmp/only"] },
    { id: "s2", start: H(2), end: H(3), cwds: ["/proj/a"] },
  ]);
  const r = derive(db, { quietHours: 8 });
  assert.equal(r.unattributed, 1);
  assert.equal(r.campaigns, 1);
  db.close();
});

test("re-deriving is idempotent and keeps a label that was set", () => {
  db = seed([
    { id: "s1", start: H(0), end: H(1), cwds: ["/proj/a"] },
    { id: "s2", start: H(2), end: H(3), cwds: ["/proj/a"] },
  ]);
  derive(db, { quietHours: 8 });
  db.prepare("UPDATE campaigns SET label='ship the thing'").run();
  const again = derive(db, { quietHours: 8 });
  assert.equal(again.campaigns, 1);
  const row = db.prepare("SELECT label, session_count FROM campaigns").get() as
    { label: string | null; session_count: number };
  assert.equal(row.label, "ship the thing", "a derived rebuild must not discard labels");
  assert.equal(row.session_count, 2);
  db.close();
});

test("usage is summed onto the campaign", () => {
  db = seed([
    { id: "s1", start: H(0), end: H(1), cwds: ["/proj/a"] },
    { id: "s2", start: H(2), end: H(3), cwds: ["/proj/a"] },
  ]);
  derive(db, { quietHours: 8 });
  const row = db.prepare("SELECT input_tokens, output_tokens, cost_usd FROM campaigns").get() as
    { input_tokens: number; output_tokens: number; cost_usd: number | null };
  assert.equal(row.input_tokens, 20);
  assert.equal(row.output_tokens, 40);
  assert.equal(row.cost_usd, null, "transcript-sourced rows carry no cost; do not invent one");
  db.close();
});

test("ephemeral paths resolve to no project at all", () => {
  assert.equal(resolveProject("/private/tmp/whatever").key, null);
  assert.equal(resolveProject("/tmp/x").kind, "ephemeral");
  assert.equal(resolveProject("/var/folders/ab/cd/T/x").kind, "ephemeral");
});

test("a vanished directory outside any repo stays itself, not its parent", () => {
  // Collapsing a deleted subdirectory into whatever parent survives would
  // invent a hub. Only a *repository* ancestor is an acceptable answer.
  //
  // Deliberately not under tmpdir(): the first version of this test built its
  // fixture there and failed, because macOS puts tmpdir() under /var/folders
  // and the ephemeral rule had already -- correctly -- classified it as scratch.
  const gone = join(homedir(), ".clt-test-no-such-dir", "deeper");
  const r = resolveProject(gone);
  assert.equal(r.key, gone);
  assert.equal(r.kind, "path");
});

test("the edge graph is persisted, not just the clusters", () => {
  // The point of keeping it: connected components is the first strategy, not
  // the last. Weighted cutting and community detection are a different
  // traversal of this table, and neither is possible if only the resulting
  // clusters were stored.
  db = seed([
    { id: "s1", start: H(0), end: H(1), cwds: ["/proj/a", "/proj/b"] },
    { id: "s2", start: H(2), end: H(3), cwds: ["/proj/a", "/proj/b"] },
    { id: "s3", start: H(4), end: H(5), cwds: ["/proj/a"] },
  ]);
  const r = derive(db, { quietHours: 8 });
  assert.equal(r.edges, 3, "every pair inside the window, not just consecutive ones");

  const strong = db.prepare(
    "SELECT shared_projects, gap_seconds FROM session_edges WHERE a='s1' AND b='s2'").get() as
    { shared_projects: number; gap_seconds: number };
  assert.equal(strong.shared_projects, 2, "two projects in common is stronger evidence");
  assert.equal(strong.gap_seconds, 3600);

  const weak = db.prepare(
    "SELECT shared_projects FROM session_edges WHERE a='s1' AND b='s3'").get() as
    { shared_projects: number };
  assert.equal(weak.shared_projects, 1);
  db.close();
});

test("raising min-weight cuts weak edges and splits campaigns", () => {
  db = seed([
    { id: "s1", start: H(0), end: H(1), cwds: ["/proj/a", "/proj/b"] },
    { id: "s2", start: H(2), end: H(3), cwds: ["/proj/a", "/proj/b"] },
    { id: "s3", start: H(50), end: H(51), cwds: ["/proj/a"] },
  ]);
  // Everything connected: one campaign per quiet run, so s3 splits on silence.
  assert.equal(derive(db, { quietHours: 200, minWeight: 0 }).campaigns, 1);
  // s1-s3 and s2-s3 are single-project and two days apart, so they fall first.
  assert.equal(
    derive(db, { quietHours: 200, minWeight: 1 }).campaigns, 2,
    "the weak long-range edge should be the one that breaks",
  );
  db.close();
});

test("the strategy that produced a campaign is recorded", () => {
  db = seed([{ id: "s1", start: H(0), end: H(1), cwds: ["/proj/a"] }]);
  derive(db, { quietHours: 8 });
  const a = db.prepare("SELECT strategy FROM campaigns").get() as { strategy: string };
  assert.match(a.strategy, /components\+quiet:8h/);
  derive(db, { quietHours: 8, minWeight: 1.5 });
  const b = db.prepare("SELECT strategy FROM campaigns").get() as { strategy: string };
  assert.match(b.strategy, /minw:1\.5/, "two strategies must be distinguishable in the table");
  db.close();
});

test("only a project key that names a GitHub repo is harvestable", () => {
  assert.equal(repoOf("github.com/owner/name"), "owner/name");
  assert.equal(repoOf("/Users/someone/Documents/Work/thing"), null,
    "a local path has no pull requests to read");
  assert.equal(repoOf("github.com/owner/name/extra"), null,
    "an over-deep key is not a repo and must not be guessed at");
});

test("an outcome is derived from artifacts, and absence is its own answer", () => {
  // 'no artifact' is deliberately distinct from 'abandoned': the first is work
  // that produced nothing durable, which may be research; the second is work
  // that produced something and had it rejected. Collapsing them would hide
  // the more interesting of the two.
  db = seed([
    { id: "s1", start: H(0), end: H(1), cwds: ["/proj/a"] },
    { id: "s2", start: H(30), end: H(31), cwds: ["/proj/b"] },
  ]);
  derive(db, { quietHours: 8 });
  const ids = (db.prepare("SELECT campaign_id FROM campaigns ORDER BY started_at").all() as
    Array<{ campaign_id: string }>).map((r) => r.campaign_id);
  assert.equal(ids.length, 2);

  db.prepare(
    "INSERT INTO campaign_artifacts(campaign_id,kind,repo,ref,state,harvested_at) " +
    "VALUES(?,'pr','o/r','1','closed','2026-01-02T00:00:00Z')").run(ids[0]!);

  const rows = db.prepare(`
    SELECT c.campaign_id,
      CASE WHEN SUM(a.state='merged')>0 THEN 'shipped'
           WHEN SUM(a.state='closed')>0 THEN 'abandoned'
           ELSE 'no artifact' END o
    FROM campaigns c LEFT JOIN campaign_artifacts a USING(campaign_id)
    GROUP BY c.campaign_id ORDER BY c.started_at`).all() as Array<{ o: string }>;
  assert.equal(rows[0]!.o, "abandoned");
  assert.equal(rows[1]!.o, "no artifact");
  db.close();
});
