import { z } from 'zod';
import { gatewayJson } from './_shared.js';
import { getAgentId } from '@cortex/sdk/auth';

export const BridgeInboxInputSchema = z.object({
  unread_only: z.boolean().optional(),
  mark_read: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
  summary_only: z.boolean().optional(),
});

export const definition = {
  name: 'bridge_inbox',
  protocolVersion: '1.0',
  description: 'Read bridge messages for the current agent.',
  inputSchema: {
    type: 'object',
    properties: {
      unread_only: { type: 'boolean' },
      mark_read: { type: 'boolean' },
      limit: { type: 'number' },
      summary_only: { type: 'boolean' },
    },
    required: [],
  },
  schema: BridgeInboxInputSchema,
  capability: 'bridge.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const agent = getAgentId(gateway);
  if (!agent) throw new Error('agent identity not configured');
  const params = new URLSearchParams();
  params.set('limit', String(args.limit || 20));
  if (args.unread_only !== undefined) params.set('unread_only', String(args.unread_only));
  if (args.mark_read !== undefined) params.set('mark_read', String(args.mark_read));
  if (args.summary_only) params.set('summary_only', 'true');
  return gatewayJson(gateway, `/v1/api/bridge/inbox/${encodeURIComponent(agent)}?${params.toString()}`);
}
