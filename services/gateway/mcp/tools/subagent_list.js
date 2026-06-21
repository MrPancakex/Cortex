import { z } from 'zod';
import { getAgentId } from '@cortex/sdk/auth';
import { listSubagents } from '@cortex/sdk/sessions';

export const SubagentListInputSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
});

export const definition = {
  name: 'subagent_list',
  protocolVersion: '1.0',
  description: 'List your registered subagents (most recent first) with status, duration, and cost.',
  inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, required: [] },
  schema: SubagentListInputSchema,
  capability: 'subagent.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  if (!gateway?.db) {
    return { ok: false, error: 'db_unavailable', detail: 'gateway.db is required for subagent_list' };
  }
  const parentAgent = getAgentId(gateway);
  if (!parentAgent) {
    return { ok: false, error: 'unauthenticated', detail: 'parent_agent identity is required' };
  }
  const subagents = listSubagents({
    db: gateway.db,
    parentAgent,
    limit: args.limit ?? 50,
  });
  return { ok: true, parent_agent: parentAgent, count: subagents.length, subagents };
}
