import { z } from 'zod';
import { gatewayJsonRaw } from './_shared.js';
import { JournalAppendSchema, JournalEntryTypeSchema } from '@cortex/core/schemas';

/**
 * task_journal — thin MCP wrapper over POST /v1/api/tasks/:id/journal
 * (tasks/journal.js appendJournalEntry). ONE home per concern:
 *
 *   - The body fields (entry_type / summary / files_changed) are passed
 *     through to the route WITHOUT local pre-validation so the route's
 *     auth-first ordering is preserved: the route checks actor first
 *     (→ 401), then validates the body (→ 400). A local safeParse before
 *     the HTTP call would invert that ordering for unauthenticated callers.
 *   - The inputSchema below is derived from JournalAppendSchema via .pick()
 *     (same home, no re-typed copy) so the advertised enum / size limits
 *     can never drift from the route. This schema is FOR DOCUMENTATION AND
 *     MANIFEST PURPOSES ONLY — it is not used for runtime rejection. The
 *     enum pin test (definition.inputSchema.properties.entry_type.enum ===
 *     JournalEntryTypeSchema.options) remains valid because the shape comes
 *     from the same schema object.
 *   - The route's 400/401/404 bodies reach the MCP caller VERBATIM (no
 *     ok:false wrapper, no reshaping) because gatewayJsonRaw returns
 *     { status, body } for every response. On 4xx/5xx the body is returned
 *     directly; on 2xx the body is returned directly.
 *   - On a missing/empty task_id (a URL-param concern, not a body field)
 *     the established tool-layer 'invalid_arguments' shape is returned —
 *     this is legitimately a tool-layer check because the tool constructs
 *     the URL.
 *   - The tool accepts no author/actor field — the author is always the
 *     authenticated agent, same as the route.
 *
 * `metadata` is intentionally NOT exposed (contract surface is
 * {task_id, entry_type, summary, files_changed?}); the route's default
 * ({}) applies, identical to an HTTP caller omitting it.
 */

// Picked from the route's schema — same home, no copy.
// Used FOR DOCUMENTATION / inputSchema manifest ONLY, NOT for runtime
// body rejection (the route does that, with auth-first ordering).
const JournalBodySchema = JournalAppendSchema.pick({
  entry_type: true,
  summary: true,
  files_changed: true,
});

export const TaskJournalInputSchema = JournalBodySchema.extend({
  task_id: z.string().min(1),
});

export const definition = {
  name: 'task_journal',
  protocolVersion: '1.0',
  description: 'Append a structured journal entry (planning/context/decision/test/blocker/handoff) to a task. Satisfies the submit/request-verification journal minimums.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      entry_type: { type: 'string', enum: JournalEntryTypeSchema.options },
      summary: { type: 'string' },
      files_changed: { type: 'array', items: { type: 'string' } },
    },
    required: ['task_id', 'entry_type', 'summary'],
  },
  schema: TaskJournalInputSchema,
  capability: 'task.journal',
};

export async function handler(args, gateway) {
  // task_id is the URL param — tool-layer concern (we build the URL).
  // Established error shape: invalid_arguments.
  const idParsed = z.object({ task_id: z.string().min(1) }).safeParse({ task_id: args?.task_id });
  if (!idParsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: idParsed.error.issues };
  }

  // Forward body fields as-given to the route — undefined keys are omitted,
  // null is NOT coalesced to undefined (the route must see null so it can
  // return its own 400 rather than silently accepting it). The route performs
  // auth first (401 before body validation), which we preserve by NOT
  // validating the body locally.
  const body = {};
  if (args.entry_type !== undefined) body.entry_type = args.entry_type;
  if (args.summary !== undefined) body.summary = args.summary;
  if (args.files_changed !== undefined) body.files_changed = args.files_changed;

  const { status, body: routeBody } = await gatewayJsonRaw(
    gateway,
    `/v1/api/tasks/${encodeURIComponent(idParsed.data.task_id)}/journal`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  // 400 (invalid_body) — return the route's body VERBATIM, no ok:false
  // wrapper or reshaping (the route body is already { error, issues }).
  if (status === 400) return routeBody;

  // 2xx — return the body directly (created entry or success payload).
  if (status >= 200 && status < 300) return routeBody;

  // 401 / 404 / other non-2xx — surface as a thrown error so callers
  // see the same rejection the route sends (missing or invalid token /
  // not_found / etc.). This matches the existing throw-on-non-ok contract
  // that the route-error-passthrough tests verify.
  throw new Error(routeBody?.error || `${status}`);
}
