import { z } from 'zod';
import { gatewayJson, persistTaskState } from './_shared.js';

export const HeartbeatInputSchema = z.object({
  task_id: z.string().optional(),
  status: z.string().optional(),
});

export const definition = {
  name: 'heartbeat',
  protocolVersion: '1.0',
  description: 'Record an agent heartbeat.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, status: { type: 'string' } }, required: [] },
  schema: HeartbeatInputSchema,
  capability: 'agent.heartbeat',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  // The mounted route (sessions/routes.js heartbeatHandler) requires `agent_id`
  // and reads `current_task`/`platform` — NOT the old {status, task_id} shape,
  // which 400'd. Derive agent_id from the gateway's resolved identity; map
  // task_id → current_task.
  const agentId = gateway?.config?.agentId;
  if (!agentId) return { ok: false, error: 'no_agent_identity' };
  const response = await gatewayJson(gateway, '/v1/api/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: agentId,
      current_task: args.task_id || null,
      platform: gateway.config.agentPlatform || null,
    }),
  });
  if (args.task_id) return persistTaskState(gateway, response, 'sync', args.task_id);
  return response;
}
