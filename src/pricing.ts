/**
 * Put a dollar figure on the 99.6% of rows that have exact tokens and no price.
 *
 * The store has two kinds of row. OTLP-sourced rows carry `cost_usd` as the
 * provider reported it. Transcript-backfilled rows carry exact token counts and
 * no price at all -- and they are almost everything, because the sink only sees
 * sessions that ran after it was started, while backfill reaches the whole
 * transcript retention window.
 *
 * So the estimate lands in `cost_est_usd`, beside the measured column rather
 * than inside it. Overwriting `cost_usd` would erase the distinction between a
 * figure the provider gave and one this file computed, and the whole point of
 * the ledger is knowing which numbers are measured.
 *
 * Two caveats that belong on every number this produces
 * -----------------------------------------------------
 * **These are first-party list rates.** Claude on Bedrock and Vertex is
 * partner-operated and priced separately; a store recorded against Vertex gets
 * a first-party approximation, not its invoice. Same for any negotiated
 * discount. Use it to compare campaigns against each other -- which is the
 * question -- not to reconcile a bill.
 *
 * **Rates change.** They are stamped with the date they were taken so a stale
 * table is visible rather than silently wrong, and `--as-of` refuses to price
 * rows newer than the table it is using.
 */

import type { DatabaseSync } from "node:sqlite";

/** Dollars per million tokens. */
export interface Rate {
  input: number;
  output: number;
  /** Cache reads are ~0.1x base input. */
  cacheRead: number;
  /** Cache writes are 1.25x base input at the default 5-minute TTL. */
  cacheWrite: number;
}

const rate = (input: number, output: number): Rate => ({
  input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25,
});

/**
 * First-party list prices, taken 2026-08-17.
 *
 * Keys are matched as prefixes against `api_requests.model`, longest first, so
 * a suffixed id (`claude-opus-5[1m]`, a dated snapshot) resolves to its family
 * without needing its own row.
 */
export const RATES: Record<string, Rate> = {
  "claude-fable-5": rate(10, 50),
  "claude-mythos-5": rate(10, 50),
  "claude-opus-5": rate(5, 25),
  "claude-opus-4-8": rate(5, 25),
  "claude-opus-4-7": rate(5, 25),
  "claude-opus-4-6": rate(5, 25),
  "claude-opus-4-5": rate(5, 25),
  "claude-sonnet-5": rate(3, 15),
  "claude-sonnet-4-6": rate(3, 15),
  "claude-sonnet-4-5": rate(3, 15),
  "claude-haiku-4-5": rate(1, 5),
};

export const RATES_TAKEN = "2026-08-17";

export function rateFor(model: string | null): Rate | null {
  if (!model) return null;
  const key = Object.keys(RATES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];   // longest prefix wins
  return key ? RATES[key]! : null;
}

export interface PriceResult {
  priced: number;
  alreadyMeasured: number;
  unpriceable: number;
  unknownModels: string[];
  estimatedUsd: number;
  measuredUsd: number;
}

export function price(db: DatabaseSync): PriceResult {
  const rows = db.prepare(
    "SELECT request_id, model, COALESCE(input_tokens,0) i, COALESCE(output_tokens,0) o, " +
    "COALESCE(cache_read,0) cr, COALESCE(cache_creation,0) cc, cost_usd " +
    "FROM api_requests",
  ).all() as Array<{
    request_id: string; model: string | null; i: number; o: number;
    cr: number; cc: number; cost_usd: number | null;
  }>;

  const upd = db.prepare("UPDATE api_requests SET cost_est_usd = ? WHERE request_id = ?");
  const unknown = new Set<string>();
  let priced = 0, alreadyMeasured = 0, unpriceable = 0, estimated = 0, measured = 0;

  db.exec("BEGIN");
  try {
    for (const r of rows) {
      if (r.cost_usd !== null) { alreadyMeasured++; measured += r.cost_usd; }
      const rt = rateFor(r.model);
      if (!rt) {
        unpriceable++;
        if (r.model) unknown.add(r.model);
        continue;
      }
      // Cache reads and writes are priced separately from fresh input: reads at
      // a tenth, writes at 1.25x. On this workload cache_read dwarfs everything
      // else -- 8.2 billion tokens against 0.5 billion of fresh input -- so
      // folding them into the input rate would overstate spend by an order of
      // magnitude, and dropping them would understate it.
      const est =
        (r.i * rt.input + r.o * rt.output + r.cr * rt.cacheRead + r.cc * rt.cacheWrite) / 1e6;
      upd.run(est, r.request_id);
      priced++;
      estimated += est;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }

  return {
    priced, alreadyMeasured, unpriceable,
    unknownModels: [...unknown].sort(),
    estimatedUsd: estimated, measuredUsd: measured,
  };
}
