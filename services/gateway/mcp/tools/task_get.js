import { z } from 'zod';
import { gatewayJson } from './_shared.js';

// Compact field set for task_get (default). Returns scalar fields + counts
// instead of full nested arrays. description_excerpt is 300 chars.
const COMPACT_FIELDS = new Set([
  'id', 'title', 'status', 'assigned_to', 'reviewer_agent',
  'priority', 'section', 'rejection_count',
  'created_at', 'updated_at', 'claimed_at', 'submitted_at', 'tags',
  // counts and excerpt are synthesised below — not picked from the response
]);

// Fields a caller may opt in to via fields: [...] — exported for get_next_task reuse.
export const ALLOWED_FIELDS = new Set([
  ...COMPACT_FIELDS,
  'description', 'result', 'created_by', 'project_id', 'phase_id',
  'metadata', 'approved_at', 'deadline',
  'progress_reports', 'comments', 'journal',
  // synthesised
  'journal_count', 'comment_count', 'progress_count', 'description_excerpt',
]);

// Exported for reuse by get_next_task — ONE implementation, no copy-paste divergence (contract R2).
export function toCompact(full) {
  const out = {};
  for (const f of COMPACT_FIELDS) {
    if (f in full) out[f] = full[f];
  }
  // Counts derive from the route payload arrays (already in-memory from the HTTP fetch).
  // COUNT(*) DB queries are NOT performed here — descoped per contract R2 (fence conflict;
  // a true no-materialization path would require route/query changes outside this fence).
  // The optimization target is RESPONSE TOKENS, not DB I/O; counts-from-arrays achieves
  // the 8.7x token reduction goal without touching the HTTP route.
  out.journal_count = Array.isArray(full.journal) ? full.journal.length : 0;
  out.comment_count = Array.isArray(full.comments) ? full.comments.length : 0;
  out.progress_count = Array.isArray(full.progress_reports) ? full.progress_reports.length : 0;
  // description_excerpt — first 300 chars of the description field.
  const desc = typeof full.description === 'string' ? full.description : '';
  out.description_excerpt = desc.slice(0, 300);
  // Preserve hint from the gateway response.
  // Real routes emit next_step_hint via hint() in _internals.js; __hint is the
  // legacy/test-harness key.  Prefer next_step_hint so compact task_get does not
  // silently drop the operational next-step guidance (ROOT 3 fix).
  if (full.next_step_hint) out.next_step_hint = full.next_step_hint;
  if (full.__hint) out.__hint = full.__hint;
  return out;
}

// Exported for reuse by get_next_task — ONE implementation, no copy-paste divergence (contract R2).
export function toFieldProjection(full, fields) {
  // Validate: every requested field must be in the allowed set.
  const unknown = fields.filter((f) => !ALLOWED_FIELDS.has(f));
  if (unknown.length > 0) {
    return { ok: false, error: 'unknown_fields', fields: unknown };
  }
  const out = {};
  for (const f of fields) {
    if (f === 'journal_count') {
      out.journal_count = Array.isArray(full.journal) ? full.journal.length : 0;
      continue;
    }
    if (f === 'comment_count') {
      out.comment_count = Array.isArray(full.comments) ? full.comments.length : 0;
      continue;
    }
    if (f === 'progress_count') {
      out.progress_count = Array.isArray(full.progress_reports) ? full.progress_reports.length : 0;
      continue;
    }
    if (f === 'description_excerpt') {
      const desc = typeof full.description === 'string' ? full.description : '';
      out.description_excerpt = desc.slice(0, 300);
      continue;
    }
    if (f in full) out[f] = full[f];
  }
  // Prefer next_step_hint; keep __hint as compat fallback (ROOT 3 fix).
  if (full.next_step_hint) out.next_step_hint = full.next_step_hint;
  if (full.__hint) out.__hint = full.__hint;
  return out;
}

export const TaskGetInputSchema = z.object({
  task_id: z.string().min(1),
  // full: true returns the byte-identical HTTP payload (today's behavior).
  // full: false (default) returns the compact projection.
  full: z.boolean().optional(),
  // fields: explicit field list; implies full=false for omitted arrays.
  // Unknown field names cause an explicit error.
  fields: z.array(z.string()).optional(),
});

export const definition = {
  name: 'task_get',
  protocolVersion: '1.0',
  description: [
    'Fetch a task. By default returns a compact payload: scalar fields + counts',
    '(journal_count, comment_count, progress_count) + description_excerpt.',
    'Pass full:true for the complete payload (journal, comments, progress_reports arrays).',
    'Pass fields:[...] to request specific fields; unknown names return an error.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      full: { type: 'boolean', description: 'Return full payload with all nested arrays. Default false.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Explicit field list to return.' },
    },
    required: ['task_id'],
  },
  schema: TaskGetInputSchema,
  capability: 'task.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;

  // Validate fields FIRST — before any early return (full:true, compact default,
  // or fields projection).  An unknown field name must always return an explicit
  // error regardless of what other arguments are present.
  const hasFields = Array.isArray(args.fields) && args.fields.length > 0;
  if (hasFields) {
    const unknown = args.fields.filter((f) => !ALLOWED_FIELDS.has(f));
    if (unknown.length > 0) {
      return { ok: false, error: 'unknown_fields', fields: unknown };
    }
    // full:true + fields is contradictory — "full = everything" vs "fields = only these".
    // Unknown-field check above takes precedence (a typo always reports unknown_fields first).
    if (args.full === true) {
      return { ok: false, error: 'invalid_arguments', detail: 'full and fields are mutually exclusive' };
    }
  }

  // Always fetch the full HTTP payload — the route is unchanged.
  const full = await gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}`);

  // full:true — return byte-identical HTTP response.
  if (args.full === true) return full;

  // fields:[...] — project to the named fields (already validated above).
  if (hasFields) {
    return toFieldProjection(full, args.fields);
  }

  // Default: compact projection.
  return toCompact(full);
}
