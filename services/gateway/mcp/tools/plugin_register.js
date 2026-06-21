/**
 * MCP tool: plugin_register.
 *
 * Exposes the plugin registry.register() path over MCP so operators can
 * register plugins from a Claude Code session without hand-rolling HTTP.
 * The MCP layer is a thin wrapper; all validation + signature checks
 * happen in services/gateway/plugins/registry.js via the HTTP route.
 *
 * Accepts either the Strict or Signed manifest shape. Parse failures
 * come back as structured errors rather than thrown exceptions so
 * callers can surface diagnostics cleanly.
 */

import { z } from 'zod';
import {
  StrictPluginManifestSchema,
  SignedPluginManifestSchema,
} from '../../../../core/schemas/plugin-manifest.js';
import { gatewayJson } from './_shared.js';

export const PluginRegisterInputSchema = z.object({
  manifest: z.union([StrictPluginManifestSchema, SignedPluginManifestSchema]),
});

export const definition = {
  name: 'plugin_register',
  protocolVersion: '1.0',
  description:
    'Register (or upsert) a plugin manifest with the gateway. '
    + 'Rejects invalid manifests and unverified signatures.',
  inputSchema: {
    type: 'object',
    properties: {
      manifest: { type: 'object', description: 'Strict or Signed plugin manifest.' },
    },
    required: ['manifest'],
  },
  schema: PluginRegisterInputSchema,
  capability: 'plugin.register',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  return gatewayJson(gateway, '/v1/api/plugins/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsed.data.manifest),
  });
}
