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

import { init, SCHEMA_VERSION } from "../src/store.ts";
import { derive, resolveProject } from "../src/campaigns.ts";
import { repoOf, harvest } from "../src/artifacts.ts";
import { price, rateFor } from "../src/pricing.ts";
import * as Communities from "../src/communities.ts";
import { parseLabels, candidates } from "../src/labeling.ts";

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

test("a model id resolves to its family by longest prefix", () => {
  // Real ids in the store carry suffixes: a 1M-context marker, a dated
  // snapshot. Matching on the exact string would leave both unpriced.
  assert.equal(rateFor("claude-opus-5")?.input, 5);
  assert.equal(rateFor("claude-opus-5[1m]")?.input, 5);
  assert.equal(rateFor("claude-haiku-4-5-20251001")?.input, 1);
  assert.equal(rateFor("claude-sonnet-5")?.output, 15);
  assert.equal(rateFor("claude-fable-5")?.output, 50);
  assert.equal(rateFor("some-other-model"), null, "an unknown model must not be guessed at");
  assert.equal(rateFor(null), null);
});

test("cache tokens are priced at their own rates, not as fresh input", () => {
  // Cache reads dominate this workload by an order of magnitude (8.2B vs 0.5B
  // fresh input), so charging them at the input rate would overstate spend
  // enormously and dropping them would understate it.
  const r = rateFor("claude-opus-5")!;
  assert.equal(r.cacheRead, 0.5, "reads are a tenth of input");
  assert.equal(r.cacheWrite, 6.25, "writes are 1.25x input");
});

test("pricing fills cost_est_usd and never touches measured cost_usd", () => {
  db = seed([{ id: "s1", start: H(0), end: H(1), cwds: ["/proj/a"] }]);
  db.prepare(
    "INSERT INTO api_requests(request_id,ts,session_id,model,input_tokens,output_tokens," +
    "cache_read,cache_creation,cost_usd,source) VALUES(?,?,?,?,?,?,?,?,?,'test')",
  ).run("r-measured", H(0), "s1", "claude-opus-5", 1_000_000, 1_000_000, 0, 0, 99.0);
  db.prepare(
    "INSERT INTO api_requests(request_id,ts,session_id,model,input_tokens,output_tokens," +
    "cache_read,cache_creation,source) VALUES(?,?,?,?,?,?,?,?,'test')",
  ).run("r-transcript", H(0), "s1", "claude-opus-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000);

  const r = price(db);
  assert.equal(r.priced, 2, "both rows carrying a model get an estimate");
  // seed() writes a row with no model at all. Leaving it unpriced rather than
  // assuming a default is the point: a fabricated rate is worse than a gap.
  assert.equal(r.unpriceable, 1);
  assert.deepEqual(r.unknownModels, [], "a null model is not an unknown model");

  const measured = db.prepare(
    "SELECT cost_usd, cost_est_usd FROM api_requests WHERE request_id='r-measured'").get() as
    { cost_usd: number; cost_est_usd: number };
  assert.equal(measured.cost_usd, 99.0, "the provider's figure must survive untouched");
  assert.equal(measured.cost_est_usd, 30, "1M in at $5 + 1M out at $25");

  const est = db.prepare(
    "SELECT cost_est_usd FROM api_requests WHERE request_id='r-transcript'").get() as
    { cost_est_usd: number };
  assert.equal(est.cost_est_usd, 5 + 25 + 0.5 + 6.25, "input + output + cache read + cache write");
  db.close();
});

test("community detection splits two cliques joined by one weak edge", () => {
  // The case the strategy exists for. It also contextualises the low Q measured
  // on real data: the algorithm works, that graph just has no structure.
  const nodes = ["a1", "a2", "a3", "b1", "b2", "b3"];
  const edges: Communities.Edge[] = [];
  for (const [x, y] of [["a1", "a2"], ["a1", "a3"], ["a2", "a3"],
                        ["b1", "b2"], ["b1", "b3"], ["b2", "b3"]]) {
    edges.push({ a: x!, b: y!, weight: 1 });
  }
  edges.push({ a: "a1", b: "b1", weight: 0.05 });   // the bridge

  const r = Communities.detect(nodes, edges);
  assert.equal(new Set(r.communityOf.values()).size, 2, "two cliques, two communities");
  assert.equal(r.communityOf.get("a1"), r.communityOf.get("a3"));
  assert.notEqual(r.communityOf.get("a1"), r.communityOf.get("b1"));
  assert.ok(r.modularity > 0.3, `Q should show real structure, got ${r.modularity}`);
});

test("a uniform clique has no structure to find, and Q says so", () => {
  // Measured on the source store: the largest cluster is 97% dense with every
  // weight between 0.92 and 1.00. No partition of it beats chance, and the
  // honest output is a low Q rather than an arbitrary split.
  const nodes = ["n1", "n2", "n3", "n4"];
  const edges: Communities.Edge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      edges.push({ a: nodes[i]!, b: nodes[j]!, weight: 1 });
    }
  }
  const r = Communities.detect(nodes, edges);
  assert.equal(new Set(r.communityOf.values()).size, 1, "a clique is one community");
  assert.ok(r.modularity < 0.1, `Q should be near zero, got ${r.modularity}`);
});

test("community detection is deterministic across runs", () => {
  // The published algorithm randomises visit order and tie-breaking. Left
  // random, a campaign id would change because the reconciler was re-run.
  const nodes = ["x", "y", "z", "w"];
  const edges: Communities.Edge[] = [
    { a: "x", b: "y", weight: 1 }, { a: "z", b: "w", weight: 1 },
    { a: "y", b: "z", weight: 0.1 },
  ];
  const a = Communities.detect(nodes, edges);
  const b = Communities.detect(nodes, edges);
  assert.deepEqual([...a.communityOf].sort(), [...b.communityOf].sort());
});

test("an isolated node is its own campaign, not the nearest one", () => {
  const r = Communities.detect(["lonely", "p", "q"], [{ a: "p", b: "q", weight: 1 }]);
  assert.equal(r.communityOf.get("lonely"), "lonely");
});

test("label parsing survives a fence or a sentence of preamble", () => {
  const withFence = 'Here you go:\n```json\n[{"id":"c1","label":"Ship the thing"}]\n```';
  assert.deepEqual(parseLabels(withFence), [{ id: "c1", label: "Ship the thing" }]);
  assert.deepEqual(parseLabels('[{"id":"c1","label":"A"},{"id":"c2","label":"B"}]').length, 2);
  assert.deepEqual(parseLabels("no json here"), []);
  assert.deepEqual(parseLabels('[{"id":"c1"}]'), [], "an entry with no label is dropped");
  assert.deepEqual(parseLabels('[{"id":"c1","label":"   "}]'), [], "blank labels are dropped");
});

test("a campaign with no prompt on any session is reported, not invented", () => {
  db = seed([{ id: "s1", start: H(0), end: H(1), cwds: ["/proj/a"] }]);
  derive(db, { quietHours: 8 });
  const before = candidates(db, false);
  assert.equal(before.length, 1);
  assert.deepEqual(before[0]!.prompts, [], "no material to name it from");

  db.prepare("UPDATE sessions SET first_prompt=? WHERE session_id='s1'")
    .run("Add a retry to the widget publisher");
  const after = candidates(db, false);
  assert.deepEqual(after[0]!.prompts, ["Add a retry to the widget publisher"]);
  db.close();
});

test("already-labelled campaigns are skipped unless relabel is asked for", () => {
  db = seed([{ id: "s1", start: H(0), end: H(1), cwds: ["/proj/a"] }]);
  derive(db, { quietHours: 8 });
  db.prepare("UPDATE campaigns SET label='already named'").run();
  assert.equal(candidates(db, false).length, 0);
  assert.equal(candidates(db, true).length, 1);
  db.close();
});

test("one pull request claimed by two campaigns is two rows but one pull request", () => {
  // Two campaigns a fortnight apart, both touching the same repository. A PR
  // opened after the later campaign started falls inside both grace windows --
  // the real store had a single PR claimed by three campaigns this way.
  const path = join(work, `${Math.random().toString(36).slice(2)}.db`);
  db = init(path);
  const repo = "github.com/acme/widget";
  for (const [id, day] of [["c1", 1], ["c2", 14]] as Array<[string, number]>) {
    const t = new Date(Date.UTC(2026, 0, day)).toISOString();
    db.prepare(
      "INSERT INTO campaigns(campaign_id,strategy,started_at,ended_at,session_count," +
      "project_count,input_tokens,output_tokens,derived_at) " +
      "VALUES(?,'components',?,?,1,1,0,0,?)").run(id, t, t, t);
    db.prepare("INSERT INTO campaign_projects(campaign_id,project_key) VALUES(?,?)")
      .run(id, repo);
  }

  const pr = (n: number, state: string, mergedAt: string | null) => ({
    number: n, state, title: `pr ${n}`, url: `u${n}`,
    createdAt: new Date(Date.UTC(2026, 0, 20)).toISOString(),
    mergedAt, closedAt: null, additions: 1, deletions: 0,
  });
  const r = harvest(db, {
    graceDays: 30, author: "someone",
    lister: () => [pr(1, "MERGED", "2026-01-21T00:00:00.000Z"), pr(2, "OPEN", null)],
  });

  assert.equal(r.artifacts, 4, "two PRs x two claiming campaigns");
  assert.equal(r.merged, 2, "the merged PR is attributed twice");
  assert.equal(r.distinctArtifacts, 2, "but there are only two pull requests");
  assert.equal(r.distinctMerged, 1, "and only one of them shipped");
  assert.equal(r.distinctOpen, 1);
  assert.equal(r.distinctClosed, 0);
  db.close();
});

test("init never moves schema_version backwards", () => {
  // A v0.1.2 sink and a v3 CLI legitimately share one store. The older build
  // opening it is harmless; the older build *restamping* it is not, because
  // openForRead then refuses a file whose tables are all present.
  const path = join(work, `${Math.random().toString(36).slice(2)}.db`);
  db = init(path);
  const read = () => (db.prepare(
    "SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value;
  assert.equal(read(), String(SCHEMA_VERSION));

  db.prepare("UPDATE meta SET value='99' WHERE key='schema_version'").run();
  db.close();
  db = init(path);
  assert.equal(read(), "99", "a newer marker survives an older build calling init");

  db.prepare("UPDATE meta SET value='1' WHERE key='schema_version'").run();
  db.close();
  db = init(path);
  assert.equal(read(), String(SCHEMA_VERSION), "an older marker is still upgraded");
  db.close();
});
