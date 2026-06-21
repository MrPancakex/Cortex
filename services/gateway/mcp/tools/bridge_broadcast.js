import { z } from 'zod';
import { gatewayJson } from './_shared.js';
import { getAgentId } from '../../../../sdk/auth/agent-context.js';
import { filterBroadcastRecipients, broadcastToAgents } from '../../bridge/broadcast.js';

export const BridgeBroadcastInputSchema = z.object({
  subject: z.string().optional(),
  body: z.string().min(1),
  type: z.string().optional(),
  priority: z.enum(['normal', 'urgent', 'critical']).optional(),
  task_id: z.string().optional(),
});

export const definition = {
  name: 'bridge_broadcast',
  protocolVersion: '1.0',
  description: 'Send a message to all agents at once.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      body: { type: 'string' },
      type: { type: 'string' },
      priority: { type: 'string', enum: ['normal', 'urgent', 'critical'] },
      task_id: { type: 'string' },
    },
    required: ['body'],
  },
  schema: BridgeBroadcastInputSchema,
  capability: 'bridge.broadcast',
};

const MCP_PRIORITY_TO_GATEWAY = {
  urgent: 'high',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const messageType = args.type || 'status_update';
  const agents = await gatewayJson(gateway, '/v1/api/agents');
  const agentList = filterBroadcastRecipients(agents.agents, getAgentId(gateway));
  return broadcastToAgents({
    agents: agentList,
    sendFn: (agentId, _payload) => gatewayJson(gateway, '/v1/api/bridge/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: agentId,
        kind: 'message',
        subject: args.subject || 'broadcast',
        content: args.body,
        task_id: args.task_id || undefined,
        priority: MCP_PRIORITY_TO_GATEWAY[args.priority] || args.priority || 'normal',
        context: {
          message_type: messageType,
        },
      }),
    }),
  });
}
