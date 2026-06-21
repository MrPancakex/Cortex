/**
 * Task state-machine — public barrel.
 *
 * Phase 3.0.b refactor: the 1011-line fork of this file has been replaced
 * with a thin re-export surface. The 14 mutating transitions live in
 * transitions.js; the 4 read-only handlers live in queries.js. Shared
 * helpers (ok, created, hint, sameAgent, requireTask, syncFiles, …) live
 * in _internals.js.
 *
 * routes.js and index.js both import from this file — they see the same
 * public surface as before.
 *
 * The critical fix: transitions.js contains the slice A C3 dual-write
 * logic (appendLedger + audit_log inside a single db.transaction). The
 * old fork in this file had NO appendLedger call, causing task.json and
 * ledger.jsonl to be skipped on every state transition.
 */
export * from './transitions.js';
export * from './delete.js';
export * from './queries.js';
