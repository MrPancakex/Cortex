import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const GatewayStatsInputSchema = z.object({
  period: z.string().optional(),
});

export const definition = {
  name: 'gateway_stats',
  protocolVersion: '1.0',
  description: 'Return aggregate gateway statistics.',
  inputSchema: { type: 'object', properties: { period: { type: 'string' } }, required: [] },
  schema: GatewayStatsInputSchema,
  capability: 'system.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const period = args.period || 'today';
  return gatewayJson(gateway, `/v1/api/stats?period=${encodeURIComponent(period)}`);
}
