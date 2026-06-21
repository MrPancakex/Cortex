import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const AgentDeleteInputSchema = z.object({
  agent_id: z.string().min(1),
});

export const definition = {
  name: 'agent_delete',
  protocolVersion: '1.0',
  description: 'Remove an agent from the dashboard. Deletes agent and session heartbeat rows. Requires admin token.',
  inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] },
  schema: AgentDeleteInputSchema,
  capability: 'agent.delete',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/agents/${encodeURIComponent(args.agent_id)}`, { method: 'DELETE' });
}
