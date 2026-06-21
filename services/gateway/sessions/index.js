/**
 * gateway/sessions — public surface. The gateway's process entry point
 * wires these together at boot:
 *
 *   mountSessionRoutes(router)
 *   startReaper({ runDir })
 *   new ProcessSupervisor({ stmts: getSessionStatements() })
 *
 * The plane wraps sdk/sessions (which owns the lease-slot primitives)
 * with event emission + persistence + supervisor integration. Direct
 * handler invocation is also exported for in-process callers (MCP tool
 * handlers, bin/cortex CLI) that want to bypass the HTTP layer.
 */

export { mountSessionRoutes } from './routes.js';

// Identity
export {
  formatSessionId,
  resolveSessionId,
  parseSessionId,
  defaultRunDir,
} from './identity.js';

// Slot registry
export {
  claimSlot,
  releaseSlot,
  refreshFromLeases,
  getActiveSlots,
  addHeldTask,
  removeHeldTask,
  resetSlotRegistryForTests,
} from './slot-registry.js';

// Heartbeat
export {
  upsertHeartbeat,
  getHeartbeat,
  getSessionHeartbeats,
} from './heartbeat.js';

// Reaper
export {
  startReaper,
  runReaperOnce,
} from './reaper.js';

// Orphan dispatcher
export { dispatchOrphan } from './orphan-dispatcher.js';

// Supervisor
export {
  ProcessSupervisor,
  SupervisedProcess,
  ProcessState,
  persistStateSafe,
  drainPersistQueue,
} from './supervisor.js';

// Logging
export {
  createAgentLogger,
  listAgentLogs,
  RotatingWriteStream,
} from './logging.js';

// Subagent runtime inference
export {
  inferSubagentRuntime,
  defaultProviderForRuntime,
  defaultModelForRuntime,
} from './subagents.js';

// Statements (exposed so server.js can share the handle with the
// supervisor; keeps supervisor persistence consistent with reaper reads).
export {
  getSessionStatements,
  resetSessionStatementsForTests,
} from './statements.js';

// Event emitters — exported for tests that want to assert emit behavior
// directly without round-tripping through the bus.
export {
  emitSessionOpened,
  emitSessionHeartbeat,
  emitSessionExpired,
  emitSessionClosed,
  emitAgentRegistered,
  emitAgentUpdated,
  emitAgentStale,
  emitTaskOrphaned,
} from './events.js';
