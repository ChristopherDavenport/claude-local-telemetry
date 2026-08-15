/**
 * Formatters.
 *
 * Two rules run through all of these.
 *
 * **Null is not zero.** Transcript-sourced rows carry no `cost_usd` at all, so
 * a null has to render as an em dash. Formatting it as `$0.0000` would state
 * that a session was free when the truth is that its cost was never recorded —
 * the single easiest way to misread this store.
 *
 * **Money gets more precision than money usually does.** Individual requests
 * land in the fractions of a cent, and rounding them to `$0.00` makes a whole
 * table look empty.
 */

const nf = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export const EM_DASH = "—";

export function count(v: number | null | undefined): string {
  return v == null ? EM_DASH : nf.format(v);
}

/** Compact form for axis ticks and dense cells: 1.2M, 43.1k. */
export function short(v: number | null | undefined): string {
  return v == null ? EM_DASH : compact.format(v);
}

/**
 * Dollars, scaled to the magnitude. Totals want cents; a single request wants
 * four decimals or it reads as free.
 */
export function usd(v: number | null | undefined): string {
  if (v == null) return EM_DASH;
  if (v === 0) return "$0";
  const digits = Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 3 : 4;
  return `$${v.toFixed(digits)}`;
}

export function ms(v: number | null | undefined): string {
  if (v == null) return EM_DASH;
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  const m = Math.floor(v / 60_000);
  return `${m}m ${Math.round((v % 60_000) / 1000)}s`;
}

export function bytes(v: number | null | undefined): string {
  if (v == null) return EM_DASH;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/** ISO-8601 UTC text from the store, rendered in the reader's local zone. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function day(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function relative(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const then = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`).getTime();
  if (Number.isNaN(then)) return EM_DASH;
  const secs = Math.round((then - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000], ["month", 2_592_000], ["day", 86_400],
    ["hour", 3600], ["minute", 60],
  ];
  for (const [unit, secsPer] of units) {
    if (Math.abs(secs) >= secsPer) return rtf.format(Math.round(secs / secsPer), unit);
  }
  return rtf.format(secs, "second");
}

/** Session ids and trace ids are long and never read in full. */
export function shortId(id: string | null | undefined, len = 8): string {
  return !id ? EM_DASH : id.length <= len ? id : id.slice(0, len);
}

/** A cwd is mostly a homedir prefix; the last two segments carry the meaning. */
export function shortPath(p: string | null | undefined): string {
  if (!p) return EM_DASH;
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

/** ISO instant N days ago, for the `since` parameter. */
export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/**
 * Cache read as a share of all input. The number people actually want from a
 * "cache ratio", and the one that moves when prompt caching regresses.
 */
export function cacheRatio(r: {
  input_tokens: number | null; cache_read: number | null; cache_creation: number | null;
}): number | null {
  const read = r.cache_read ?? 0;
  const total = (r.input_tokens ?? 0) + read + (r.cache_creation ?? 0);
  return total === 0 ? null : read / total;
}

export function percent(v: number | null | undefined, digits = 0): string {
  return v == null ? EM_DASH : `${(v * 100).toFixed(digits)}%`;
}
