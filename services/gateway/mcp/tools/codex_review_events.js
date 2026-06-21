/**
 * MCP tool: codex_review_events.
 *
 * §12.8 decision (2026-04-24): per-turn event streams are IN-MEMORY by
 * design, not a pending TODO. Events live in the reviewer plugin's
 * in-process registry (plugins/codex-reviewer/state.js appendEvent /
 * listEvents) for the lifetime of the plugin. No persisted event log.
 *
 * Thread continuity across restarts IS preserved via codex_review_threads
 * (migration 011). That table does not store events — it only maps
 * (task, reviewer) → Codex conversation id.
 *
 * The descriptor stays intact so downstream tool registries see the same
 * surface and receive a structured `not_available` response.
 */

import { z } from 'zod';

export const CodexReviewEventsInputSchema = z.object({
  run_id: z.string().min(1),
});

export const definition = {
  name: 'codex_review_events',
  protocolVersion: '1.0',
  description: 'List the persisted events for a single Codex review run.',
  inputSchema: {
    type: 'object',
    properties: { run_id: { type: 'string' } },
    required: ['run_id'],
  },
  schema: CodexReviewEventsInputSchema,
  capability: 'review.read',
};

const NOT_AVAILABLE_RESPONSE = Object.freeze({
  ok: false,
  error: 'not_available',
  reason: 'codex_review_tables_not_part_of_rebuild',
  detail:
    'Per-turn Codex review events are intentionally in-memory (§12.8 decision 2026-04-24). Events live in the reviewer plugin registry for the plugin lifetime; there is no persistent event view. NOTE: per-task thread continuity IS persisted in the codex_review_threads table (migration 011); this stub only covers the per-turn event log, not thread continuity. If run-level observability becomes important, reconsider adding an append-only view — not scheduled.',
  phase: 11,
  by_design: true,
});

export async function handler(args, _gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  return NOT_AVAILABLE_RESPONSE;
}
