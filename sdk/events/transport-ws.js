/**
 * WebSocket transport. Builds a handler pair (open / close) that the
 * gateway's WS upgrade code can bind to the `/api/events/ws` route.
 * The handler:
 *   1. Reads `since` and `subject` from the upgrade query string.
 *   2. Subscribes to the bus FIRST (live events are buffered until
 *      backfill completes).
 *   3. Backfills from the durable table via getCursor() — bounded at
 *      MAX_BACKFILL_BATCHES × 1000 rows so a client asking for
 *      `since=0&subject=*` on a multi-million-row table can't pin the
 *      gateway on replay.
 *   4. Flushes the live buffer, deduping against the highest seq seen
 *      during backfill so events that landed in BOTH (backfill SQL saw
 *      it AND it was also published through the bus) only ship once.
 *   5. Forwards every live event afterward as a single JSON frame.
 *
 * Subscribe-first is deliberate: previously `backfill()` ran to
 * completion and `subscribe()` attached after. An event inserted
 * between the final `getCursor` read and the `subscribe` call would
 * land in the DB (too late for backfill) and publish through the bus
 * to no registered handler (too early for live) — silent gap. Flipping
 * the order plus buffering closes that window completely.
 *
 * The framing deliberately sends raw envelope-shaped objects (plus
 * `seq`) rather than a wrapping {type, data} envelope — the `subject`
 * field is the type, and every frame is identically shaped so a
 * consumer never needs to switch on a discriminator.
 */

import { getCursor, subscribe } from './index.js';
import { swallow } from '../errors/index.js';

const MAX_BACKFILL_BATCHES = 10;
const BACKFILL_BATCH_SIZE = 1000;

function parseIntSafe(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * @param {URL | { searchParams: URLSearchParams }} url
 * @returns {{ subject: string, since: number }}
 */
export function parseWsQuery(url) {
  const params = url.searchParams;
  const subject = params.get('subject') || '*';
  const since = parseIntSafe(params.get('since'), 0);
  return { subject, since };
}

/**
 * Create a handler pair bound to one WebSocket-like object. `ws` must
 * expose `send(string)` and `close(code, reason)`. The caller is
 * responsible for invoking `onOpen()` once the upgrade completes and
 * `onClose()` when the socket drops.
 *
 * @param {{ send: (msg: string) => void, close?: (code?: number, reason?: string) => void }} ws
 * @param {{ subject: string, since: number }} query
 */
export function createEventsWsHandler(ws, query) {
  let unsubscribe = null;
  let closed = false;

  // Subscribe-first bookkeeping. Events published to the bus while
  // `backfilling` is true go to `liveBuffer` and are flushed after
  // backfill completes. `lastBackfillSeq` is the cutoff the flush uses
  // to decide "already sent via backfill, skip."
  //
  // Growth bound: liveBuffer is implicitly capped because `backfill()`
  // runs synchronously and is itself bounded at MAX_BACKFILL_BATCHES ×
  // BACKFILL_BATCH_SIZE (10,000) rows. onOpen completes in tens of
  // milliseconds for normal workloads, so only emits that land in that
  // window ever buffer here — the backfill cap IS the buffer cap.
  let backfilling = true;
  let lastBackfillSeq = query.since;
  const liveBuffer = [];

  const sendFrame = (event) => {
    if (closed) return;
    try {
      ws.send(JSON.stringify(event));
    } catch (err) {
      swallow('events.ws_send_failed', err);
    }
  };

  const liveHandler = (event) => {
    if (backfilling) {
      liveBuffer.push(event);
      return;
    }
    if (event?.seq != null && event.seq <= lastBackfillSeq) return;
    sendFrame(event);
  };

  const backfill = () => {
    let cursor = query.since;
    for (let batch = 0; batch < MAX_BACKFILL_BATCHES; batch += 1) {
      if (closed) return cursor;
      let rows;
      try {
        rows = getCursor(query.subject, cursor, BACKFILL_BATCH_SIZE);
      } catch (err) {
        swallow('events.ws_backfill_failed', err);
        return cursor;
      }
      if (rows.length === 0) return cursor;
      for (const row of rows) sendFrame(row);
      cursor = rows[rows.length - 1].seq;
      if (rows.length < BACKFILL_BATCH_SIZE) return cursor;
    }
    // Hit the MAX_BACKFILL_BATCHES cap without exhausting the table. More
    // events between `cursor` and the live subscription's first event
    // exist and are NOT going to be sent via this socket. Emit a sentinel
    // frame so the client knows to use the /api/events cursor endpoint
    // to catch up the gap instead of silently missing rows.
    sendFrame({
      _control: 'backfill_truncated',
      last_seq: cursor,
      hint: 'historical depth exceeds the ws backfill cap; use /api/events?since=<last_seq> to catch up',
    });
    return cursor;
  };

  return {
    onOpen() {
      // If the socket already closed before onOpen ran (out-of-order
      // lifecycle in the WS library), skip all work. Without this
      // guard, a subsequent subscribe() would register a handler that
      // nobody can unsubscribe — onClose already finished and cleared
      // `unsubscribe` — leaking liveBuffer + closure refs for process
      // lifetime.
      if (closed) return;

      // Register the live subscription FIRST so any emit during the
      // backfill window (or between the last getCursor and the end of
      // onOpen) has a destination. Buffered live events are flushed
      // below after backfill returns.
      unsubscribe = subscribe(query.subject, liveHandler);

      lastBackfillSeq = backfill();
      backfilling = false;

      if (closed) {
        // onClose fired during backfill. Tear the subscription down
        // now since onClose cannot (it already ran when unsubscribe
        // was null). Swallow so a broken unsubscribe path doesn't
        // crash the upgrade handler.
        try {
          unsubscribe?.();
        } catch (err) {
          swallow('events.ws_unsubscribe_failed', err);
        }
        unsubscribe = null;
        return;
      }
      // Flush the live buffer. Dedup via `seq <= lastBackfillSeq` so an
      // event that the backfill SQL picked up AND that the bus
      // published during onOpen is still sent exactly once.
      while (liveBuffer.length > 0) {
        const event = liveBuffer.shift();
        if (event?.seq != null && event.seq <= lastBackfillSeq) continue;
        sendFrame(event);
      }
    },
    onClose() {
      closed = true;
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch (err) {
          swallow('events.ws_unsubscribe_failed', err);
        }
        unsubscribe = null;
      }
    },
  };
}
