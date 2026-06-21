/**
 * HTTP polling cursor transport. Callers GET
 *   /api/events?since=<seq>&subject=<glob>&limit=<n>
 * and receive a JSON response of the next batch of rows. Hard-capped at
 * 1000 rows per request (enforced by getCursor).
 *
 * This is the fallback transport for clients that can't hold a
 * WebSocket open — dashboards with restrictive proxies, CLI tools, etc.
 */

import { getCursor } from './index.js';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

function parseIntSafe(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Build a JSON response body for a cursor request.
 *
 * @param {URL | { searchParams: URLSearchParams }} url
 * @returns {{ status: number, body: unknown }}
 */
export function handleCursorRequest(url) {
  const params = url.searchParams;
  const subject = params.get('subject') || '*';
  const since = parseIntSafe(params.get('since'), 0);
  const requestedLimit = parseIntSafe(params.get('limit'), DEFAULT_LIMIT);
  const limit = Math.min(Math.max(1, requestedLimit), MAX_LIMIT);

  const events = getCursor(subject, since, limit);
  const nextSince = events.length > 0 ? events[events.length - 1].seq : since;

  return {
    status: 200,
    body: {
      events,
      next_since: nextSince,
      count: events.length,
      subject,
    },
  };
}
