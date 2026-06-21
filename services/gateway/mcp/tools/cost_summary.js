import { z } from 'zod';
import { getAgentId } from '@cortex/sdk/auth';
import { costForAgentBase } from '../../meta/telemetry.js';
import { normaliseBaseAgentId } from '../stdio-bootstrap.js';

export const CostSummaryInputSchema = z.object({
  period: z.string().optional(),
  task_id: z.string().optional(),
});

export const definition = {
  name: 'cost_summary',
  protocolVersion: '1.0',
  description: 'Return token usage and cost summary for the current agent.',
  inputSchema: { type: 'object', properties: { period: { type: 'string' }, task_id: { type: 'string' } }, required: [] },
  schema: CostSummaryInputSchema,
  capability: 'cost.read',
};

// Foundation F R1-1: wired to REAL aggregates over telemetry ∪ proxy_logs
// (disjoint by migration-016 design — the union is not a double-count).
// Aggregates in-process from the gateway DB via meta/telemetry.js — does NOT
// depend on proxy/cost-routes.js (broken on this branch). Returns the calling
// agent's own totals (identity from the gateway auth context, not the body).
//
// R1b FIX 1: roll up by the agent's BASE id, not the configured slot. The
// gateway config carries the SESSION SLOT (e.g. `nova-2`); telemetry rows
// carry that slot while proxy_logs rows carry the BASE (`nova`). Aggregating
// by the slot would miss every base-stamped proxy row, so we peel the slot
// suffix (reusing normaliseBaseAgentId — the same helper stdio-bootstrap uses
// to derive a base from a slot id) and roll up across all of the agent's slots.
export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  const agentId = getAgentId(gateway);
  if (!agentId) {
    return { ok: false, error: 'unauthenticated', reason: 'agent identity unresolved' };
  }
  const base = normaliseBaseAgentId(agentId);
  const totals = costForAgentBase(base);
  return {
    ok: true,
    agent_id: base,
    total_requests: totals.requests,
    total_tokens_in: totals.tokens_in,
    total_tokens_out: totals.tokens_out,
    total_cost_usd: totals.total_cost_usd,
  };
}
