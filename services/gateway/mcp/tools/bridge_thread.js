import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const BridgeThreadInputSchema = z.object({
  message_id: z.string().min(1),
});

export const definition = {
  name: 'bridge_thread',
  protocolVersion: '1.0',
  description: 'Get the full reply chain for a message.',
  inputSchema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'] },
  schema: BridgeThreadInputSchema,
  capability: 'bridge.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/bridge/thread/${encodeURIComponent(args.message_id)}`);
}
