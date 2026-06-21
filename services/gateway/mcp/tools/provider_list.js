/**
 * MCP tool: provider_list
 *
 * Wraps GET /v1/api/providers. Returns all configured providers plus
 * registry_state metadata. No auth required — registry config is admin-set
 * and status does not leak secrets.
 *
 * Slice C Phase 9.
 */

import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const ProviderListInputSchema = z.object({}).passthrough();

export const definition = {
  name: 'provider_list',
  protocolVersion: '1.0',
  description: 'List all configured providers and registry state. No authentication required.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  schema: ProviderListInputSchema,
  capability: 'provider.read',
};

/**
 * @param {object} args
 * @param {object} gateway
 */
export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  return gatewayJson(gateway, '/v1/api/providers');
}
