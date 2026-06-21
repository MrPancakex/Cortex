import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const AgentUpdateInputSchema = z.object({
  agent_id: z.string().min(1),
  model: z.string().optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
});

export const definition = {
  name: 'agent_update',
  protocolVersion: '1.0',
  description: 'Update an agent model, provider, or status.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      model: { type: 'string' },
      provider: { type: 'string' },
      status: { type: 'string' },
    },
    required: ['agent_id'],
  },
  schema: AgentUpdateInputSchema,
  capability: 'agent.update',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/agents/${encodeURIComponent(args.agent_id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: args.model, provider: args.provider, status: args.status }),
  });
}
