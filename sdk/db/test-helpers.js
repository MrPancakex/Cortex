/**
 * Test-only helpers for the sdk/db plane. Kept out of production code
 * paths so production modules don't carry a reset surface that could
 * accidentally be called at runtime.
 *
 * The legacy gateway's db module carried a `_resetJsonParseSeen` helper
 * tied to a first-failure-dedup Set inside `jsonParse`. The rebuild's
 * `safeJsonParse` (sdk/http/json-parse.js) has no such dedup state, so
 * the helper's legacy equivalent is unnecessary. The surface that DOES
 * need a test-reset hook is the db connection singleton — tests that
 * run in the same bun:test process need a clean database handle between
 * suites to avoid cross-suite state leakage.
 */

import { closeDb } from './connection.js';

/**
 * Release the cached db singleton. The next `getDb({ path })` call will
 * honor whatever override it's given and open a different file.
 * Idempotent: safe to call even when no db is currently open.
 */
export function resetDbForTests() {
  closeDb();
}
