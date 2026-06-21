import { z } from 'zod';
import { notImplementedStub } from './_shared.js';

export const ModelListInputSchema = z.object({}).passthrough();

export const definition = {
  name: 'model_list',
  protocolVersion: '1.0',
  description: '[stub] List available Ollama models.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  schema: ModelListInputSchema,
  capability: 'model.read',
};

export async function handler(args, _gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  return notImplementedStub({
    reason: 'model_list_route_not_mounted',
    tracking: 'docs/cortex-rebuild-port-audit-2026-04-24.md §2.2 Routing',
    detail: 'The gateway does not yet mount /v1/api/model/list. Model allowlist + cost table are available via @cortex/core/constants/models.',
  });
}
