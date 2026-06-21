import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const BridgeReplyInputSchema = z.object({
  message_id: z.string().min(1),
  body: z.string().min(1),
});

export const definition = {
  name: 'bridge_reply',
  protocolVersion: '1.0',
  description: 'Reply to a bridge message.',
  inputSchema: { type: 'object', properties: { message_id: { type: 'string' }, body: { type: 'string' } }, required: ['message_id', 'body'] },
  schema: BridgeReplyInputSchema,
  capability: 'bridge.send',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/bridge/reply/${encodeURIComponent(args.message_id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: args.body }),
  });
}
