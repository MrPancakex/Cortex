/**
 * MCP tool: codex_review_list.
 *
 * §12.8 decision (2026-04-24): run-level state is IN-MEMORY by design,
 * not a pending TODO. Runs + events live in the reviewer plugin's
 * in-process registry (see plugins/codex-reviewer/state.js). The
 * correctness anchor is the bridge tables — a review is complete iff a
 * reply row exists for the original review_request, testable without
 * any run row.
 *
 * Thread continuity across restarts IS preserved via codex_review_threads
 * (migration 011), which stores (task, reviewer) → Codex conversation id
 * only — not runs.
 *
 * The descriptor is preserved so downstream MCP clients that hard-coded
 * `codex_review_list` continue to discover the surface and get a clean,
 * structured error they can match on rather than an opaque HTTP 404.
 */

import { z } from 'zod';

export const CodexReviewListInputSchema = z
  .object({
    task_id: z.string().optional(),
    reviewer_agent: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(25),
  })
  .refine((v) => v.task_id || v.reviewer_agent, {
    message: 'either task_id or reviewer_agent is required',
  });

export const definition = {
  name: 'codex_review_list',
  protocolVersion: '1.0',
  description: 'List Codex review runs by task or reviewer agent.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      reviewer_agent: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
    },
  },
  schema: CodexReviewListInputSchema,
  capability: 'review.read',
};

const NOT_AVAILABLE_RESPONSE = Object.freeze({
  ok: false,
  error: 'not_available',
  reason: 'codex_review_tables_not_part_of_rebuild',
  detail:
    'Run-level state for Codex reviews is intentionally in-memory (§12.8 decision 2026-04-24). Runs live in the reviewer plugin registry; the bridge review_request/reply pair is the correctness anchor. If you need run history, query the bridge inbox for review_request messages and their replies. NOTE: per-task thread continuity IS persisted in the codex_review_threads table (migration 011) so a gateway restart mid-review keeps the same Codex conversation alive — this stub only covers the run-listing surface, not thread continuity.',
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
