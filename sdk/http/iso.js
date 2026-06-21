export function toIso(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number') {
    // Accept epoch 0 (Unix epoch) as a valid instant — `!value` would drop
    // it. Also guard against NaN.
    if (!Number.isFinite(value)) return null;
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    if (value === '') return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function fromIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// S1 — canonical timestamp-normalisation homes (SSOT spec §3).
//
// Two normalised forms are used inside the gateway:
//   • SQLite space-form "YYYY-MM-DD HH:MM:SS"  — written to DB columns and
//     audit rows so they are byte-identical to SQLite's datetime('now').
//   • ISO-T form       "YYYY-MM-DDTHH:MM:SS"   — used in event streams
//     and fold-engine comparisons (second-precision, no ms, no Z).
//
// Both strip sub-second precision so field-level comparisons between
// task.json timestamps (may carry .000Z) and DB values (no ms, no Z)
// produce stable equality — preventing the reconciler from spuriously
// re-updating rows on every run.
//
// Returns null for null/undefined.
// Returns the input string unchanged when it does not look like a
// timestamp — garbage stays visible and drifts loudly rather than
// collapsing to null.
// ---------------------------------------------------------------------------

const TS_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/;

/**
 * Normalise any timestamp to SQLite space-form "YYYY-MM-DD HH:MM:SS".
 * Canonical home for every write that stores a timestamp in the DB.
 */
export function normSqliteTs(ts) {
  if (ts == null) return null;
  const m = String(ts).match(TS_RE);
  if (!m) return String(ts);
  return `${m[1]} ${m[2]}`; // SPACE separator — matches SQLite datetime('now')
}

/**
 * Normalise any timestamp to ISO-T form "YYYY-MM-DDTHH:MM:SS".
 * Canonical home for fold-engine comparisons and event-stream normalisation.
 */
export function normIsoTs(ts) {
  if (ts == null) return null;
  const m = String(ts).match(TS_RE);
  if (!m) return String(ts);
  return `${m[1]}T${m[2]}`; // T separator — ISO 8601, second precision, no Z
}

/**
 * Normalise any timestamp to ISO-Z second-precision form
 * "YYYY-MM-DDTHH:MM:SSZ".
 */
export function normSqliteToIsoZ(ts) {
  const t = normIsoTs(ts);
  return t == null ? null : `${t}Z`;
}

/**
 * Return the current UTC instant as a full ISO-8601 string
 * ("YYYY-MM-DDTHH:MM:SS.mmmZ"). Use this everywhere a "now" timestamp is
 * written to an event stream or an API response field — it must carry full
 * ms precision so callers can sort by it.
 */
export function nowIso() {
  return new Date().toISOString();
}
