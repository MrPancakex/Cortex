import { z } from 'zod';
import { getAgentId } from '@cortex/sdk/auth';

export const BridgeDeleteInputSchema = z.object({
  message_id: z.string().min(1),
});

export const definition = {
  name: 'bridge_delete',
  protocolVersion: '1.0',
  description: 'Delete a bridge message by ID. Only the sender or an admin may delete.',
  inputSchema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'] },
  schema: BridgeDeleteInputSchema,
  capability: 'bridge.delete',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const db = gateway.db;
  if (!db) throw new Error('gateway.db not available');
  const msg = db.prepare(`SELECT id, from_agent, to_agent FROM bridge_messages WHERE id = ?`).get(args.message_id);
  if (!msg) throw new Error('bridge message not found');
  const agent = getAgentId(gateway);
  if (!agent) throw new Error('agent identity not configured');
  if (msg.from_agent !== agent && agent !== 'admin') {
    throw new Error('forbidden: only the sender or an admin may delete a bridge message');
  }
  const r = db.prepare(`DELETE FROM bridge_messages WHERE id = ?`).run(args.message_id);
  return { deleted: r.changes === 1, message_id: args.message_id };
}
