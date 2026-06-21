/**
 * gateway/auth — public surface for the RBAC auth/check plane.
 *
 * Exports from check.js:
 *   mountAuthRoutes(adapter)   — registers GET /v1/api/auth/check
 *   evaluateAccess(opts)       — pure matcher, importable for tests + other planes
 *   reloadMatrix(filePath?)    — force matrix reload (called on SIGHUP)
 *   normalizePath(inputPath)   — path normalization for external callers
 *   globMatch(pattern, target) — glob matcher for external callers
 *
 * Exports from scope-config.js (P3.5 bearer-scope assignments):
 *   resolveScopeFromBearer(hash) — map bearer hash → scope name
 *   getScopeRules(scopeName)     — raw rules array for a scope
 *   reload()                     — SIGHUP reload for both files
 */

export {
  mountAuthRoutes,
  evaluateAccess,
  evaluateApiMutation,
  reloadMatrix,
  resetMatrixForTests,
  getMatrix,
  isMatrixLoadFailed,
  normalizePath,
  globMatch,
  resolveScope,
  authCheckHandler,
  isRbacDisabled,
} from './check.js';

export {
  resolveScopeFromBearer,
  getScopeRules,
  reload as reloadScopeConfig,
} from './scope-config.js';

// Scope-grant admin endpoints (Unix-socket-only).
export { mountGrantRoutes } from './routes.js';
export {
  createGrant,
  revokeGrant,
  lookupGrant,
  listGrants,
  startGrantReaper,
  resetGrantsForTests,
} from './grants.js';
