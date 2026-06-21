import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const BridgeMarkReadInputSchema = z.object({
  message_ids: z.array(z.string().min(1)).min(1),
});

export const definition = {
  name: 'bridge_mark_read',
  protocolVersion: '1.0',
  description: 'Mark specific messages as read without acknowledging.',
  inputSchema: { type: 'object', properties: { message_ids: { type: 'array', items: { type: 'string' } } }, required: ['message_ids'] },
  schema: BridgeMarkReadInputSchema,
  capability: 'bridge.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, '/v1/api/bridge/mark-read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_ids: args.message_ids }),
  });
}
