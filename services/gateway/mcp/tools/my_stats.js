import { z } from 'zod';
import { getAgentId } from '@cortex/sdk/auth';
import { costForAgentBase } from '../../meta/telemetry.js';
import { normaliseBaseAgentId } from '../stdio-bootstrap.js';

export const MyStatsInputSchema = z.object({
  period: z.string().optional(),
});

export const definition = {
  name: 'my_stats',
  protocolVersion: '1.0',
  description: 'Get your own token usage, cost, and request stats.',
  inputSchema: { type: 'object', properties: { period: { type: 'string' } }, required: [] },
  schema: MyStatsInputSchema,
  capability: 'cost.read',
};

// Foundation F R1-1: the caller's OWN totals over telemetry ∪ proxy_logs
// (disjoint by migration-016 design). Aggregates in-process from the gateway
// DB via meta/telemetry.js; identity comes from the gateway auth context.
//
// R1b FIX 1: roll up by the agent's BASE id (peeled from the configured slot
// via normaliseBaseAgentId), not the raw slot — telemetry rows carry the slot
// (`nova-2`) and proxy_logs rows carry the base (`nova`), so a base-rollup is
// the only match that counts both halves. See cost_summary.js for the detail.
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
