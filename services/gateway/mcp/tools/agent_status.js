import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const AgentStatusInputSchema = z.object({
  agent_id: z.string().optional(),
  agent: z.string().optional(),
});

export const definition = {
  name: 'agent_status',
  protocolVersion: '1.0',
  description: 'Return one agent or all agents.',
  inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: [] },
  schema: AgentStatusInputSchema,
  capability: 'agent.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const agentId = args.agent_id || args.agent;
  return gatewayJson(gateway, agentId
    ? `/v1/api/agents/${encodeURIComponent(agentId)}`
    : '/v1/api/agents');
}
