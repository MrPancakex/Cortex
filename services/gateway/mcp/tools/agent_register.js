import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const AgentRegisterInputSchema = z.object({
  name: z.string().min(1),
  platform: z.string().min(1),
  model: z.string().optional(),
  provider: z.string().optional(),
});

export const definition = {
  name: 'agent_register',
  protocolVersion: '1.0',
  description: 'Register a new agent and return its token. Requires admin token.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      platform: { type: 'string' },
      model: { type: 'string' },
      provider: { type: 'string' },
    },
    required: ['name', 'platform'],
  },
  schema: AgentRegisterInputSchema,
  capability: 'agent.register',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, '/v1/api/agents/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: args.name,
      platform: args.platform,
      model: args.model || null,
      provider: args.provider || null,
    }),
  });
}
