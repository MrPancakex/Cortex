import { z } from 'zod';
import { getAgentId } from '@cortex/sdk/auth';
import { registerSubagent } from '@cortex/sdk/sessions';

export const SubagentRegisterInputSchema = z.object({
  description: z.string().min(1),
  subagent_type: z.string().optional(),
  task_id: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  runtime: z.string().optional(),
});

export const definition = {
  name: 'subagent_register',
  protocolVersion: '1.0',
  description: 'Register a sub-agent or background task in the Cortex dashboard.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string' },
      subagent_type: { type: 'string' },
      task_id: { type: 'string' },
      model: { type: 'string' },
      provider: { type: 'string' },
      runtime: { type: 'string' },
    },
    required: ['description'],
  },
  schema: SubagentRegisterInputSchema,
  capability: 'subagent.register',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  if (!gateway?.db) {
    return { ok: false, error: 'db_unavailable', detail: 'gateway.db is required for subagent_register' };
  }
  const parentAgent = getAgentId(gateway);
  if (!parentAgent) {
    return { ok: false, error: 'unauthenticated', detail: 'parent_agent identity is required' };
  }
  const { eventId, subagentId } = registerSubagent({
    db: gateway.db,
    parentAgent,
    subagentType: args.subagent_type,
    description: args.description,
    taskId: args.task_id ?? null,
    model: args.model ?? null,
    provider: args.provider ?? null,
    runtime: args.runtime || 'claude',
  });
  return { ok: true, event_id: eventId, subagent_id: subagentId };
}
