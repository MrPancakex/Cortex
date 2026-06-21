import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const HealthCheckInputSchema = z.object({}).passthrough();

export const definition = {
  name: 'health_check',
  protocolVersion: '1.0',
  description: 'Return system health.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  schema: HealthCheckInputSchema,
  capability: 'system.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  return gatewayJson(gateway, '/v1/api/health');
}
