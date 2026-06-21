import { z } from 'zod';
import { notImplementedStub } from './_shared.js';

export const ErrorHistoryInputSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
  since: z.string().optional(),
});

export const definition = {
  name: 'error_history',
  protocolVersion: '1.0',
  description: '[stub] Return recent gateway errors for the current agent.',
  inputSchema: { type: 'object', properties: { limit: { type: 'number' }, since: { type: 'string' } }, required: [] },
  schema: ErrorHistoryInputSchema,
  capability: 'logs.read',
};

export async function handler(args, _gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  return notImplementedStub({
    reason: 'errors_route_not_mounted',
    tracking: 'docs/cortex-rebuild-port-audit-2026-04-24.md §2.2 Observability',
    detail: 'The gateway does not yet mount /v1/api/errors. Error history is available via gateway_logs aggregation once the route lands.',
  });
}
