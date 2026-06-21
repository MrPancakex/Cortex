import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const TelemetryReportInputSchema = z.object({
  method: z.string().optional(),
  endpoint: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  tokens_in: z.number().int().nonnegative().optional(),
  tokens_out: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  latency_ms: z.number().int().nonnegative().optional(),
});

export const definition = {
  name: 'telemetry_report',
  protocolVersion: '1.0',
  description: 'Report token usage and cost to the gateway for tracking.',
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string' },
      endpoint: { type: 'string' },
      model: { type: 'string' },
      provider: { type: 'string' },
      tokens_in: { type: 'integer' },
      tokens_out: { type: 'integer' },
      cost_usd: { type: 'number' },
      latency_ms: { type: 'integer' },
    },
    required: [],
  },
  schema: TelemetryReportInputSchema,
  capability: 'telemetry.write',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  const data = parsed.data;
  // Forward to the mounted ingest route (Foundation F2). The reporting
  // agent is derived gateway-side from the auth context (x-cortex-session /
  // bearer), not from the body — gatewayJson stamps those headers. We send
  // only the usage facts the schema defines.
  return gatewayJson(gateway, '/v1/api/gateway/telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: data.method ?? null,
      endpoint: data.endpoint ?? null,
      model: data.model ?? null,
      provider: data.provider ?? null,
      tokens_in: data.tokens_in ?? 0,
      tokens_out: data.tokens_out ?? 0,
      cost_usd: data.cost_usd ?? 0,
      latency_ms: data.latency_ms ?? 0,
    }),
  });
}
