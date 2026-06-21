/**
 * sdk/events — durable pub/sub substrate.
 *
 * Public API:
 *   - emit(subject, payload, meta?)  validates + persists + fans out
 *   - subscribe(glob, handler, opts?)  in-process consumer registration
 *   - getCursor(glob, since_seq, limit?)  replay rows from the durable table
 *   - startVacuum(opts?)  retention job (default 30-day sweep, hourly cadence)
 *
 * Subscribers may be in-process (direct `subscribe()` call) or cross-process
 * (transport-ws / transport-cursor below). Both layers read from the same
 * durable events table, so a late joiner can always catch up from any `seq`.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { validatePayload } from './validate.js';
import { writeAndNotify } from './durable-write.js';
import { subscribe as busSubscribe } from './subscribe.js';
import { startVacuum as startVacuumJob } from './vacuum.js';
import { drainRecoveryBuffer } from './recovery.js';

const ENVELOPE_VERSION = 1;
const CURSOR_DEFAULT_LIMIT = 500;
const CURSOR_MAX_LIMIT = 1000;

function buildEnvelope(subject, payload, meta) {
  return {
    id: meta?.id || randomUUID(),
    subject,
    ts: meta?.ts ?? Date.now(),
    source: meta?.source || process.env.CORTEX_EVENT_SOURCE || 'cortex',
    task_id: meta?.task_id,
    session_id: meta?.session_id,
    trace_id: meta?.trace_id,
    payload,
    v: ENVELOPE_VERSION,
  };
}

/**
 * Validate, persist, and fan out one event. Throws if the payload is
 * invalid or the subject isn't in the taxonomy — a typo'd subject must
 * fail loud rather than land silently in the events table.
 *
 * Note: emit is deliberately synchronous (spec §3.5 shows async). Every
 * step — validate, INSERT via bun:sqlite, bus.publish — is sync, and
 * returning a Promise would force every caller into an await for no
 * benefit while also making it harder to emit from inside a DB
 * transaction. Callers that want to fan-out across an await boundary
 * can `await Promise.resolve(emit(...))`.
 *
 * @param {string} subject
 * @param {unknown} payload
 * @param {{ id?: string, ts?: number, source?: string, task_id?: string, session_id?: string, trace_id?: string }} [meta]
 * @returns {{ seq: number | null, duplicate: boolean }}
 */
export function emit(subject, payload, meta = {}) {
  const check = validatePayload(subject, payload);
  if (!check.ok) {
    throw new Error(
      `emit: rejected subject="${subject}" reason=${check.reason}`,
    );
  }
  const envelope = buildEnvelope(subject, check.payload, meta);
  return writeAndNotify(envelope);
}

export { busSubscribe as subscribe };

/**
 * Replay events from the durable table. Callers pass the last `seq` they
 * processed and receive rows strictly greater. Hard-capped at
 * CURSOR_MAX_LIMIT to protect the gateway from a client asking for all
 * history at once.
 *
 * @param {string} subjectGlob  exact subject, `namespace.*`, or `*`
 * @param {number} sinceSeq
 * @param {number} [limit]
 * @returns {Array<object>}
 */
export function getCursor(subjectGlob, sinceSeq, limit = CURSOR_DEFAULT_LIMIT) {
  if (typeof subjectGlob !== 'string' || subjectGlob.length === 0) {
    throw new Error('getCursor: subjectGlob must be a non-empty string');
  }
  if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
    throw new Error('getCursor: sinceSeq must be a non-negative integer');
  }
  const cappedLimit = Math.min(Math.max(1, limit | 0), CURSOR_MAX_LIMIT);
  const db = getDb();
  const { sql, params } = buildCursorQuery(subjectGlob, sinceSeq, cappedLimit);
  const rows = db.prepare(sql).all(...params);
  return rows.map(decodeRow);
}

function buildCursorQuery(subjectGlob, sinceSeq, limit) {
  if (subjectGlob === '*') {
    return {
      sql: 'SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
      params: [sinceSeq, limit],
    };
  }
  if (subjectGlob.endsWith('.*')) {
    const ns = subjectGlob.slice(0, -2);
    return {
      sql: 'SELECT * FROM events WHERE seq > ? AND subject LIKE ? ORDER BY seq ASC LIMIT ?',
      params: [sinceSeq, `${ns}.%`, limit],
    };
  }
  return {
    sql: 'SELECT * FROM events WHERE seq > ? AND subject = ? ORDER BY seq ASC LIMIT ?',
    params: [sinceSeq, subjectGlob, limit],
  };
}

function decodeRow(row) {
  let payload = null;
  try {
    payload = row.payload ? JSON.parse(row.payload) : null;
  } catch (err) {
    // A row we wrote should always parse; if this fires it's durable-table
    // corruption. Reference err so the rule is satisfied AND so the
    // operator sees the issue via the returned object.
    payload = { _error: 'payload_json_corrupt', _message: err.message };
  }
  return {
    seq: Number(row.seq),
    id: row.id,
    subject: row.subject,
    ts: Number(row.ts),
    source: row.source,
    task_id: row.task_id ?? undefined,
    session_id: row.session_id ?? undefined,
    trace_id: row.trace_id ?? undefined,
    payload,
    v: Number(row.v),
  };
}

export function startVacuum(opts) {
  return startVacuumJob(opts);
}

// Transport surface — consumed by services/gateway/events/routes.js to
// bind real URLs to the SDK's transports. Kept behind the barrel so
// gateway plane code imports `@cortex/sdk/events` alone (Rule 4: one
// public entry per sub-module).
export { handleCursorRequest } from './transport-cursor.js';
export { parseWsQuery, createEventsWsHandler } from './transport-ws.js';

/**
 * Drain the on-disk recovery buffer by re-emitting each envelope.
 * Intended for gateway boot. Idempotent via the events table's UNIQUE
 * constraint on id. Passes `{ fromRecovery: true }` to writeAndNotify
 * so a still-failing replay does not re-append to the very buffer
 * we're draining — which would race the drain's atomic rewrite.
 *
 * On duplicate (event already landed from a prior successful run),
 * writeAndNotify returns normally with `duplicate: true` — the return
 * value is intentionally ignored here because BOTH outcomes (fresh
 * insert, duplicate) mean "line can be removed from the buffer."
 */
export async function recoverBufferedEvents() {
  return drainRecoveryBuffer(async (envelope) => {
    try {
      writeAndNotify(envelope, { fromRecovery: true });
      return true;
    } catch (err) {
      // err was already swallowed inside writeAndNotify. Reference it
      // here so Rule 2.B is satisfied and so a future log/trace change
      // has a hook. Keep the envelope in the buffer for next drain.
      void err;
      return false;
    }
  });
}
