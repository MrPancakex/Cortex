import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const LogsQueryInputSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
  status: z.string().optional(),
  since: z.string().optional(),
});

export const definition = {
  name: 'logs_query',
  protocolVersion: '1.0',
  description: 'Return recent gateway logs for the current agent.',
  inputSchema: { type: 'object', properties: { limit: { type: 'number' }, status: { type: 'string' }, since: { type: 'string' } }, required: [] },
  schema: LogsQueryInputSchema,
  capability: 'logs.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const params = new URLSearchParams();
  params.set('limit', String(args.limit || 20));
  if (args.status) params.set('status', args.status);
  if (args.since) params.set('since', args.since);
  return gatewayJson(gateway, `/v1/api/gateway/logs?${params.toString()}`);
}
