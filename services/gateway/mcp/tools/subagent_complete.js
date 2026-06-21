import { z } from 'zod';
import { getAgentId } from '@cortex/sdk/auth';
import {
  completeSubagent,
  SUBAGENT_TERMINAL_STATUSES,
} from '@cortex/sdk/sessions';

// Lifecycle outcomes for a subagent_events row. Tightening the schema
// here (was previously z.string().optional()) prevents callers from
// stamping arbitrary status values like 'in_progress' or 'paused' onto
// a row that's supposed to be transitioning to a terminal state.
// SUBAGENT_TERMINAL_STATUSES is the SDK's source of truth — keeping the
// enum consistent across the boundary + the SDK helper avoids drift.
export const SubagentCompleteInputSchema = z.object({
  event_id: z.string().min(1),
  status: z.enum(SUBAGENT_TERMINAL_STATUSES).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  tool_calls: z.number().int().nonnegative().optional(),
  result_summary: z.string().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  cached_input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
});

export const definition = {
  name: 'subagent_complete',
  protocolVersion: '1.0',
  description: 'Mark a sub-agent as completed (or failed/cancelled) with duration, work product, and cost.',
  inputSchema: {
    type: 'object',
    properties: {
      event_id: { type: 'string' },
      status: { type: 'string', enum: [...SUBAGENT_TERMINAL_STATUSES] },
      duration_ms: { type: 'integer' },
      tool_calls: { type: 'integer' },
      result_summary: { type: 'string' },
      input_tokens: { type: 'integer' },
      cached_input_tokens: { type: 'integer' },
      output_tokens: { type: 'integer' },
      cost_usd: { type: 'number' },
    },
    required: ['event_id'],
  },
  schema: SubagentCompleteInputSchema,
  capability: 'subagent.complete',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  if (!gateway?.db) {
    return { ok: false, error: 'db_unavailable', detail: 'gateway.db is required for subagent_complete' };
  }
  const parentAgent = getAgentId(gateway);
  if (!parentAgent) {
    return { ok: false, error: 'unauthenticated', detail: 'parent_agent identity is required' };
  }
  // completeSubagent UPDATE pins parent_agent in the WHERE clause so a
  // stolen event_id cannot be closed by an agent that doesn't own it.
  // The denial path returns false (changes=0) and we surface
  // event_not_found — same shape as a stale id, so we don't leak
  // existence of another agent's event.
  const updated = completeSubagent({
    db: gateway.db,
    eventId: args.event_id,
    parentAgent,
    status: args.status || 'completed',
    durationMs: args.duration_ms,
    toolCalls: args.tool_calls,
    resultSummary: args.result_summary,
    inputTokens: args.input_tokens,
    cachedInputTokens: args.cached_input_tokens,
    outputTokens: args.output_tokens,
    costUsd: args.cost_usd,
  });
  if (!updated) {
    return { ok: false, error: 'event_not_found', detail: `no running subagent_event with id ${args.event_id}` };
  }
  return { ok: true, event_id: args.event_id };
}
