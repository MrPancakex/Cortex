/**
 * @cortex/core — pure schemas and constants.
 *
 * This module MUST remain dependency-free beyond `zod`, `node:path`,
 * `node:url`, and `node:os`. Downstream layers import from here; a cycle or
 * heavy dep here poisons the whole runtime.
 *
 * Phase 1 surface:
 *   - Schemas: verbatim lifts of `shared/schemas/*.js` (task, bridge, agent,
 *     progress) PLUS two new schemas (plugin-manifest, tool-definition).
 *   - Constants: documented extractions from the legacy gateway (ports,
 *     models, status, priorities, providers, payload-caps, logging,
 *     credentials, session, process, paths).
 *
 * Convenience re-exports below surface the most-used names. The canonical
 * surfaces are `./schemas/index.js` and `./constants/index.js`.
 */
export * as schemas from './schemas/index.js';
export * as constants from './constants/index.js';

// Convenience schema re-exports — matches shared/schemas/index.js plus Phase 1
// additions (PluginManifestSchema, ToolDefinitionSchema).
export {
  // task.js
  TaskStatusSchema,
  TaskPrioritySchema,
  TaskCreateSchema,
  RequestVerificationSchema,
  // bridge.js
  BridgeSendSchema,
  BridgeInboxSchema,
  // agent.js
  AgentStatusSchema,
  AgentIdSchema,
  TaskIdSchema,
  AgentRegisterSchema,
  HeartbeatSchema,
  GetNextTaskSchema,
  // progress.js
  ProgressStatusSchema,
  ProgressReportSchema,
  // plugin-manifest.js (NEW)
  PluginManifestSchema,
  PluginKindSchema,
  PluginRuntimeSchema,
  SemverSchema,
  // tool-definition.js (NEW)
  ToolDefinitionSchema,
} from './schemas/index.js';

// Convenience constant re-exports — the surface that later phases
// (documented in the execution breakdown §1.6) expect to import from
// `@cortex/core/constants`.
export {
  // ports.js
  GATEWAY_PORT,
  PLATFORM_PORT,
  MCP_PORT,
  // payload-caps.js
  MAX_BODY_BYTES,
  MAX_WS_PER_AGENT,
  MAX_REJECTIONS,
  // status.js
  TASK_STATUSES,
  SESSION_STATUSES,
  AGENT_STATUSES,
  // priorities.js
  PRIORITY_RANK,
  // models.js
  MODEL_COST_TABLE,
  // session.js
  POISON_SWEEP_MS,
  LEASE_SUFFIX,
  // paths.js
  CORTEX_HOME,
  WORKSPACE_ROOT,
  DATA_DIR,
  // providers.js
  PROVIDER_ROUTES,
  OLLAMA_HOST,
  // credentials.js
  CREDS_DIR,
  CREDENTIAL_MAP,
  // process.js
  ProcessState,
  // logging.js
  ROTATION_ESCALATE_AFTER,
} from './constants/index.js';
