import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const BridgeAckInputSchema = z.object({
  message_id: z.string().min(1),
});

export const definition = {
  name: 'bridge_ack',
  protocolVersion: '1.0',
  description: 'Acknowledge receipt of a bridge message.',
  inputSchema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'] },
  schema: BridgeAckInputSchema,
  capability: 'bridge.ack',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/bridge/ack/${encodeURIComponent(args.message_id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}
