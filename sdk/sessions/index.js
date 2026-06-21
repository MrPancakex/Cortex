/**
 * Sessions barrel. The public surface for session-slot lifecycle, PID
 * liveness, lease management, and per-session runtime helpers. Every
 * consumer (tasks plane, MCP tool handlers, bin/cortex hook CLI, the
 * SessionEnd backstop reaper) imports from here so Rule 1 (downward-only
 * deps) and Rule 4 (one public entry per sub-module) both hold.
 */

// Session-slot lifecycle (legacy services/gateway/lib/session.js, split
// per Rule 3 into narrow sibling files).
export { formatSessionId, resolveSessionId } from './id.js';
export { defaultRunDir, leasePath } from './paths.js';
export { readPidStartTime, isPidAlive } from './pid.js';
export { isLeasePidAlive, getActiveSlots } from './lease.js';
export { claimSessionSlot } from './claim.js';
export { releaseSessionSlot, releaseSessionSlotIfDead } from './release.js';

// Upper-half helpers that shipped in the first Phase 2 pass — already
// approved in isolation; re-exported here so callers see the full
// sessions surface in one place.
export {
  resolveRuntimeDir,
  activeProjectPath,
  writeActiveProject,
  clearActiveProject,
} from './runtime-config.js';

// Subagent activity + cost ledger (subagent_events table, migration 010).
// Earlier rebuild passes deleted this module because its prior incarnation
// round-tripped through unmounted /api/subagents/* HTTP routes. The current
// rewrite writes directly to the DB, so the no-route footgun is gone and
// the lifecycle hooks can carry the dashboard's "what is each agent
// working on" view through cutover.
//
// Process-management subagent tools (subagent_spawn / wait / close) still
// belong to the §12.6 Plane 1 supervisor and remain stubbed.
export {
  SUBAGENT_TERMINAL_STATUSES,
  generateSubagentEventId,
  registerTaskWorker,
  completeTaskWorker,
  failTaskWorker,
  lookupRunningTaskWorker,
  registerSubagent,
  completeSubagent,
  listSubagents,
} from './subagent-lifecycle.js';
