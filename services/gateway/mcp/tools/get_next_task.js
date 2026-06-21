import { z } from 'zod';
import { gatewayJson } from './_shared.js';
import { agentContext } from '@cortex/sdk/auth';
// Reuse task_get's projection helpers — ONE implementation, no copy-paste divergence (contract R2).
import { toCompact, toFieldProjection, ALLOWED_FIELDS } from './task_get.js';

// get_next_task's real route (queries.js:73-115) returns ONLY summary shapes
// (review/pending) or a no-work sentinel — NEVER serializeTaskDetail.  The
// compact projection (toCompact) is therefore pass-through in production; it
// would only fire if a future code change returned a full serializeTaskDetail
// shape (one containing journal/comments/progress_reports arrays).  Non-full
// shapes pass through unchanged so message + next_step_hint are preserved.
// (contract R2 — get_next_task added to the named list after the adversarial
// verifier's class-enumeration finding).

export const GetNextTaskInputSchema = z.object({
  platform: z.string().optional(),
  // full: true returns the byte-identical HTTP payload (today's behavior).
  // full: false (default) returns the compact projection — same bounds as task_get.
  full: z.boolean().optional(),
  // fields: explicit field list; unknown names return explicit error.
  fields: z.array(z.string()).optional(),
});

export const definition = {
  name: 'get_next_task',
  protocolVersion: '1.0',
  description: [
    'Fetch the next pending task for this platform without claiming it.',
    'By default returns a compact payload: scalar fields + counts + description_excerpt.',
    'Pass full:true for the complete payload (journal, comments, progress_reports arrays).',
    'Pass fields:[...] to request specific fields; unknown names return an error.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      platform: { type: 'string' },
      full: { type: 'boolean', description: 'Return full payload with all nested arrays. Default false.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Explicit field list to return.' },
    },
    required: [],
  },
  schema: GetNextTaskInputSchema,
  capability: 'task.read',
};

/**
 * Detect whether the route returned a non-full-task payload.
 *
 * The /tasks/next route returns three distinct shapes:
 *   1. Full serializeTaskDetail — has journal/comments/progress_reports arrays
 *      (claim_task / get_next_task when a full task is available).
 *   2. Summary shape (review/pending) — {id, title, description, status,
 *      reviewer_agent | priority, created_at, next_step_hint} — NO nested arrays.
 *   3. No-work sentinel — {id: null, message, next_step_hint}.
 *
 * toCompact (designed for the full serializeTaskDetail) relies on the nested
 * arrays for counts, and would reduce the no-work sentinel to
 * {id:null, journal_count:0, …, description_excerpt:''}, dropping message +
 * next_step_hint.  Pass non-full shapes through unchanged so the agent sees the
 * real message and can act on it.
 */
function isFullTaskDetail(response) {
  if (!response || typeof response !== 'object') return false;
  // No-work sentinel: id is null.
  if (response.id == null) return false;
  // Summary shapes lack the nested arrays.  A full serializeTaskDetail always
  // has journal (may be []).  Check for the property existence rather than
  // truthiness so an empty journal [] still qualifies.
  return 'journal' in response && 'comments' in response && 'progress_reports' in response;
}

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }

  // Validate fields FIRST — before fetching and before any early return
  // (full:true, non-full pass-through, compact default, fields projection).
  // An unknown field name must always return an explicit error regardless of
  // what other arguments are present or what shape the route would return.
  const hasFields = Array.isArray(parsed.data.fields) && parsed.data.fields.length > 0;
  if (hasFields) {
    const unknown = parsed.data.fields.filter((f) => !ALLOWED_FIELDS.has(f));
    if (unknown.length > 0) {
      return { ok: false, error: 'unknown_fields', fields: unknown };
    }
    // full:true + fields is contradictory — "full = everything" vs "fields = only these".
    // Unknown-field check above takes precedence (a typo always reports unknown_fields first).
    if (parsed.data.full === true) {
      return { ok: false, error: 'invalid_arguments', detail: 'full and fields are mutually exclusive' };
    }
  }

  const { platform } = agentContext(gateway);
  const usePlatform = parsed.data.platform || platform;
  // Always fetch the full HTTP payload — the route is unchanged.
  const full = await gatewayJson(gateway, `/v1/api/tasks/next?platform=${encodeURIComponent(usePlatform)}`);

  // full:true — return byte-identical HTTP response.
  if (parsed.data.full === true) return full;

  // fields:[...] — valid names confirmed above; project or pass through.
  // For full serializeTaskDetail shapes, project; for non-full shapes
  // (summary/no-work), pass through unchanged (message+next_step_hint must
  // be preserved — ROOT 1 fix).
  if (hasFields) {
    if (!isFullTaskDetail(full)) return full;
    return toFieldProjection(full, parsed.data.fields);
  }

  // Non-full shapes (no-work sentinel, review/pending summaries) pass through
  // unchanged — toCompact is designed for serializeTaskDetail and would drop
  // message + next_step_hint from these shapes.
  if (!isFullTaskDetail(full)) return full;

  // Default: compact projection (same helpers as task_get — no divergence).
  return toCompact(full);
}
