/**
 * _meta.js — canonical home for task-metadata parsing (S3 SSOT).
 *
 * ONE contract: parseTaskMetadata(raw, options?)
 *   - success  → returns the parsed object (always an object, never null)
 *   - corrupt  → calls onError (if supplied) then returns { _error: 'metadata_corrupt' }
 *
 * Sentinel shape: { _error: 'metadata_corrupt' }
 *   Chosen over the silent-{} form used by access.js / task-projection.js /
 *   project-routes.js because it makes corrupt rows VISIBLE at the API layer
 *   (matches serialize.js which is the HTTP serializer — callers can already
 *   handle this sentinel in rendered output). The silent-{} form hid corruption
 *   from operators; the sentinel surfaces it.
 *
 * LIVE DEFECT (S3 / queries.js:79): one corrupt metadata row would throw
 *   inside getNextTask's reviewer scan because that path had no try/catch.
 *   All callers using parseTaskMetadata are protected — the function never
 *   throws.
 *
 * Import path for all gateway/tasks consumers:
 *   import { parseTaskMetadata } from './_meta.js';
 */

import { safeJsonParse } from '@cortex/sdk/http';

/**
 * Parse a raw task metadata value into a plain object. Never throws.
 *
 * @param {string|object|null|undefined} raw   — the raw metadata column value
 * @param {{ onError?: (err: Error) => void }} [options]
 * @returns {object} — the parsed metadata, or { _error: 'metadata_corrupt' }
 */
export function parseTaskMetadata(raw, { onError } = {}) {
  // Already an object — pass through (handles pre-parsed values from tests).
  if (raw != null && typeof raw === 'object') return raw;

  // Normalise to string.
  const str = (raw == null || raw === '') ? '{}' : String(raw);

  const result = safeJsonParse(str);

  if ('value' in result) {
    // safeJsonParse returns { value } on success.
    const v = result.value;
    // Parsed successfully but produced a non-object (e.g. a bare array or
    // number) — treat as corrupt so consumers always get a plain object.
    if (v == null || typeof v !== 'object' || Array.isArray(v)) {
      if (onError) {
        try { onError(new Error(`metadata_corrupt: expected object, got ${JSON.stringify(v)}`)); }
        catch (_) { /* onError itself must not throw */ }
      }
      return { _error: 'metadata_corrupt' };
    }
    return v;
  }

  // safeJsonParse returns { error } on failure.
  if (onError) {
    try { onError(new Error(`metadata_corrupt: ${result.error?.message ?? 'parse_error'}`)); }
    catch (_) { /* onError itself must not throw */ }
  }
  return { _error: 'metadata_corrupt' };
}
