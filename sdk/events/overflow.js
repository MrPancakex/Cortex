/**
 * Per-subscriber overflow counters. Incremented by the bus when a
 * subscriber's delivery queue is full and an event has to be dropped.
 * /health scrapes `getOverflowCounters()` so operators can see WHICH
 * subscriber is falling behind, not just that someone is.
 */

const _counters = new Map();

export function bumpOverflow(subscriberId) {
  _counters.set(subscriberId, (_counters.get(subscriberId) || 0) + 1);
}

export function getOverflowCounters() {
  return Object.fromEntries(_counters);
}

export function resetOverflowCounters() {
  _counters.clear();
}
