/**
 * gateway/gate — public surface for the Phase 7 gate plane.
 *
 * Wiring (the gateway's process entry point — server.js — uses these at
 * boot):
 *
 *   mountGateRoutes(adapter)
 *   refreshPolicies()                       // initial cache hydrate
 *   writeRegistrySnapshot(registry)         // called by sdk/auth boot +
 *                                           // SIGHUP reload so the gate's
 *                                           // auth middleware sees the
 *                                           // current token set.
 *
 * Direct imports of the sub-modules are discouraged — every external
 * caller routes through this barrel so the Rule 3 lint (no cross-plane
 * deep imports) stays satisfied. Tests are the exception: they import
 * the per-module reset helpers (resetGateStatementsForTests,
 * resetPolicyCacheForTests) through this barrel so the harness can
 * clear state between suites.
 */

// HTTP route mount -------------------------------------------------------
export { mountGateRoutes } from './routes.js';

// Policy store -----------------------------------------------------------
export {
  refreshPolicies,
  listPolicies,
  orderedPolicies,
  getPolicyById,
  upsertPolicy,
  removePolicy,
  policyCacheSize,
  policyCacheVersion,
  resetPolicyCacheForTests,
} from './policies.js';

// Evaluator --------------------------------------------------------------
export { evaluate } from './evaluator.js';

// Rate limiter -----------------------------------------------------------
export {
  checkIp,
  checkAgent,
  checkPolicyBucket,
  configureRateLimiter,
  disposeRateLimiter,
  snapshotBuckets,
} from './rate-limit.js';

// Auth middleware --------------------------------------------------------
export {
  resolveSubject,
  reconcilePathIdentity,
  writeRegistrySnapshot,
  readRegistrySnapshot,
} from './auth-middleware.js';

// Submission content guards ---------------------------------------------
export {
  inspectSubmission,
  stubDetectorMiddleware,
} from './stub-detector.js';

export {
  getRejectionCount,
  wouldExceedCap,
  summariseTaskRejections,
  maxRejectionsMiddleware,
} from './max-rejections.js';

// Fine-grained permission grants ----------------------------------------
export {
  hasPermission,
  grantPermission,
  revokePermission,
  listPermissions,
  requirePermissionMiddleware,
} from './permissions.js';

// Statements — exposed so tests can reset the cache between DB swaps. --
export {
  getGateStatements,
  resetGateStatementsForTests,
} from './statements.js';

// Event emitters — re-exported so downstream planes that need to emit
// a gate event directly (e.g. gate telemetry in a different process)
// can, without importing './events.js'.
export {
  emitGateAllowed,
  emitGateDenied,
  emitGateRateLimited,
  emitGateLoaded,
  emitGatePolicyWritten,
} from './events.js';
