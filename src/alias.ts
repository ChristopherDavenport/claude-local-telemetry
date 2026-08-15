/**
 * Populating `plugin_alias`, which is what un-blinds per-plugin spend.
 *
 * OTel reports every plugin outside the official marketplace as the literal
 * string `third-party` on `plugin.name`. What it does give you is
 * `plugin_id_hash`: stable, distinct per plugin, and meaningless on its own.
 *
 * The transcript for the same turn names the plugin outright, in
 * `attributionPlugin`, and both sources key on the same `request_id`. So the
 * mapping does not have to be guessed from fingerprints — it can be *read off*
 * rows where the two sources describe the same request. That is what `derive`
 * does, and why the resulting rows are marked `derived` rather than `inferred`.
 *
 * This is the one module here that writes. It is deliberately not in
 * `queries.ts`, which every read-only caller shares.
 */

import type { DatabaseSync } from "node:sqlite";

export interface AliasRow {
  plugin_id_hash: string;
  plugin_name: string;
  marketplace: string | null;
  confidence: string;
  noted_at: string | null;
}

const UPSERT =
  "INSERT INTO plugin_alias (plugin_id_hash, plugin_name, marketplace, confidence, noted_at)" +
  " VALUES (?,?,?,?,?) ON CONFLICT(plugin_id_hash) DO UPDATE SET" +
  "  plugin_name = excluded.plugin_name," +
  "  marketplace = COALESCE(excluded.marketplace, plugin_alias.marketplace)," +
  "  confidence  = excluded.confidence," +
  "  noted_at    = excluded.noted_at";

/** Record a mapping by hand. Overwrites a derived one — a human is better evidence. */
export function set(
  db: DatabaseSync,
  o: { hash: string; name: string; marketplace?: string | undefined; now?: string | undefined },
): void {
  db.prepare(UPSERT).run(
    o.hash, o.name, o.marketplace ?? null, "manual", o.now ?? new Date().toISOString(),
  );
}

export function remove(db: DatabaseSync, hash: string): number {
  const before = count(db);
  db.prepare("DELETE FROM plugin_alias WHERE plugin_id_hash = ?").run(hash);
  return before - count(db);
}

export function list(db: DatabaseSync): AliasRow[] {
  return db.prepare(
    "SELECT plugin_id_hash, plugin_name, marketplace, confidence, noted_at" +
    " FROM plugin_alias ORDER BY plugin_name",
  ).all() as unknown as AliasRow[];
}

function count(db: DatabaseSync): number {
  return (db.prepare("SELECT count(*) AS c FROM plugin_alias").get() as { c: number }).c;
}

export interface DeriveResult {
  learned: number;
  ambiguous: Array<{ plugin_id_hash: string; names: string[] }>;
  hashesSeen: number;
  hashesResolved: number;
}

/**
 * Learn hash → name from requests both sources described.
 *
 * A hash that maps to more than one name is *not* written. That happens when a
 * request was attributed to different plugins by the two sources, and picking
 * the more frequent one would bake a guess into a table whose whole purpose is
 * to be trustworthy. Those are returned for a human to settle with `set`.
 *
 * Existing manual rows are never overwritten: a person who typed a name in has
 * given better evidence than a join.
 */
export function derive(db: DatabaseSync, now = new Date().toISOString()): DeriveResult {
  const pairs = db.prepare(
    "SELECT plugin_id_hash AS hash, plugin_resolved AS name," +
    " max(marketplace_name) AS marketplace, count(*) AS n" +
    " FROM api_requests" +
    " WHERE plugin_id_hash IS NOT NULL AND plugin_resolved IS NOT NULL" +
    "   AND plugin_resolved <> 'third-party'" +
    " GROUP BY plugin_id_hash, plugin_resolved",
  ).all() as Array<{ hash: string; name: string; marketplace: string | null; n: number }>;

  const byHash = new Map<string, typeof pairs>();
  for (const p of pairs) {
    if (!byHash.has(p.hash)) byHash.set(p.hash, []);
    byHash.get(p.hash)!.push(p);
  }

  const manual = new Set(
    (db.prepare("SELECT plugin_id_hash FROM plugin_alias WHERE confidence = 'manual'")
      .all() as Array<{ plugin_id_hash: string }>).map((r) => r.plugin_id_hash),
  );

  const stmt = db.prepare(UPSERT);
  const ambiguous: DeriveResult["ambiguous"] = [];
  let learned = 0;
  for (const [hash, rows] of byHash) {
    if (manual.has(hash)) continue;
    if (rows.length > 1) {
      ambiguous.push({ plugin_id_hash: hash, names: rows.map((r) => r.name).sort() });
      continue;
    }
    const r = rows[0]!;
    stmt.run(hash, r.name, r.marketplace, "derived", now);
    learned++;
  }

  const seen = db.prepare(
    "SELECT count(DISTINCT plugin_id_hash) AS c FROM api_requests WHERE plugin_id_hash IS NOT NULL",
  ).get() as { c: number };
  const resolved = db.prepare(
    "SELECT count(DISTINCT a.plugin_id_hash) AS c FROM api_requests a" +
    " JOIN plugin_alias p USING(plugin_id_hash)",
  ).get() as { c: number };

  return { learned, ambiguous, hashesSeen: seen.c, hashesResolved: resolved.c };
}

/**
 * Push resolved names back onto the rows.
 *
 * `plugin_resolved` is the column the cost queries group by, so learning a name
 * only pays off once it reaches the requests that were blinded. Only fills
 * nulls; a name already on the row came from a transcript and is first-hand.
 */
export function apply(db: DatabaseSync): number {
  const before = (db.prepare(
    "SELECT count(*) AS c FROM api_requests WHERE plugin_resolved IS NULL",
  ).get() as { c: number }).c;
  db.exec(
    "UPDATE api_requests SET plugin_resolved = (" +
    "  SELECT p.plugin_name FROM plugin_alias p" +
    "   WHERE p.plugin_id_hash = api_requests.plugin_id_hash)" +
    " WHERE plugin_resolved IS NULL AND plugin_id_hash IS NOT NULL" +
    "   AND EXISTS (SELECT 1 FROM plugin_alias p WHERE p.plugin_id_hash = api_requests.plugin_id_hash)",
  );
  const after = (db.prepare(
    "SELECT count(*) AS c FROM api_requests WHERE plugin_resolved IS NULL",
  ).get() as { c: number }).c;
  return before - after;
}
