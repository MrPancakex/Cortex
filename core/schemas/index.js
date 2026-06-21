/**
 * Schema barrel. Every public surface (HTTP handler, MCP tool, event envelope)
 * MUST validate through one of these schemas before trusting input.
 *
 * Phase 1 — mirrors `shared/schemas/index.js` re-export surface (star-exports
 * of task / bridge / agent / progress) plus the two NEW Phase 1 schemas
 * (plugin-manifest, tool-definition).
 */
export * from './bridge.js';
export * from './task.js';
export * from './progress.js';
export * from './agent.js';

export {
  PluginManifestSchema,
  PluginKindSchema,
  PluginRuntimeSchema,
  SemverSchema,
  StrictPluginManifestSchema,
  SignedPluginManifestSchema,
  PluginTrustKeySchema,
  PluginTrustStoreSchema,
} from './plugin-manifest.js';

export { ToolDefinitionSchema } from './tool-definition.js';

// Event envelopes live in a nested namespace; populated in Phase 3.
export * as events from './events/index.js';
