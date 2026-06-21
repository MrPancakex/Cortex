import { z } from 'zod';
import { gatewayJson } from './_shared.js';
import { getAgentId } from '@cortex/sdk/auth';

export const BridgePollInputSchema = z.object({
  limit: z.number().int().positive().max(200).optional(),
});

export const definition = {
  name: 'bridge_poll',
  protocolVersion: '1.0',
  description: 'Check for unread messages. Use when idle or between tasks.',
  inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
  schema: BridgePollInputSchema,
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
  params.set('unread_only', 'true');
  params.set('mark_read', 'false');
  const result = await gatewayJson(gateway, `/v1/api/bridge/inbox/${encodeURIComponent(agent)}?${params.toString()}`);
  return { messages: result.messages || [], count: result.messages?.length || 0 };
}
