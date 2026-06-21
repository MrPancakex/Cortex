/**
 * gateway/tasks — public surface. The gateway's process entry point
 * (server.js, Phase 8) wires these together at boot:
 *
 *   mountTaskRoutes(adapter)
 *   mountProjectRoutes(adapter)
 *   mountPhaseRoutes(adapter)
 *
 * Direct handler invocation is also exported for in-process callers
 * (MCP tool handlers, bin/cortex CLI, Phase 6 sessions reaper) that
 * want to bypass the HTTP layer.
 *
 * Every function re-exported here follows the same
 * `(args) => { status, body }` shape so callers can uniformly
 * toResponse() them.
 */

// HTTP route mounts -------------------------------------------------------
export { mountTaskRoutes } from './routes.js';
export { mountProjectRoutes } from './project-routes.js';
export { mountPhaseRoutes } from './phase-routes.js';

// State machine — the 15+ task transitions ------------------------------
export {
  createTask,
  listTasks,
  getTask,
  getNextTask,
  claimTask,
  resumeTask,
  reportProgress,
  submitTask,
  requestVerification,
  approveTask,
  rejectTask,
  updateTask,
  cancelTask,
  releaseTask,
  reassignTask,
  commentTask,
  reopenTask,
  getAudit,
} from './state-machine.js';

// Journal plane (Phase 5) ------------------------------------------------
export {
  appendJournalEntry,
  readJournal,
  checkJournalCompleteness,
} from './journal.js';

// Orphan plane (Phase 5 / Phase 6 interop) ------------------------------
export { orphanTask, claimOrphan } from './orphan.js';

// Orphan event subscriber — wires the sessions plane's task.orphaned
// emit to orphanTask's DB write. Without this, dead sessions leak tasks
// into perpetual `claimed`/`in_progress`. composer.js calls
// startTaskOrphanSubscriber() at boot.
export { startTaskOrphanSubscriber } from './orphan-subscriber.js';

// Project / phase surface -----------------------------------------------
export {
  createProject,
  listProjectsHandler,
  getProjectHandler,
  updateProject,
  listProjectTasks,
} from './project-routes.js';

export {
  listPhasesForProject,
  addPhase,
  deletePhase,
} from './phase-routes.js';

// Statements — exported so tests can reset the cache between DB swaps.
export {
  getTaskStatements,
  resetTaskStatementsForTests,
} from './statements.js';

// Access predicates — exported so Phase 7's gate plane can re-use them.
export { taskVisibleToAgent, canClaimPendingTask } from './access.js';

// Event emitters — re-exported so Phase 6's sessions reaper can emit
// task.orphaned without importing './events.js' directly.
export {
  emitTaskCreated,
  emitTaskClaimed,
  emitTaskResumed,
  emitTaskProgressed,
  emitTaskSubmitted,
  emitTaskReviewRequested,
  emitTaskApproved,
  emitTaskRejected,
  emitTaskOrphaned,
  emitTaskOrphanClaimed,
  emitTaskReopened,
  emitTaskCanceled,
  emitTaskUpdated,
  emitTaskReleased,
  emitTaskReassigned,
  emitTaskComment,
  emitSubmissionReceived,
  emitSubmissionFlaggedStub,
  emitSubmissionFlaggedMissingJournal,
} from './events.js';
