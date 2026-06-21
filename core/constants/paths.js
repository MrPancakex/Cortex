/**
 * Filesystem path constants and resolvers. Lifted from
 * `services/gateway/lib/task-files.js:7-18` so downstream consumers
 * (Phase 5 tasks plane, Phase 10 platform, installers) can import a single
 * canonical surface: `CORTEX_HOME`, `WORKSPACE_ROOT`, `DATA_DIR`,
 * `resolveProjectsRoot`, `resolveWorkspaceRoot`.
 *
 * Pure module — no fs reads at import time. Resolvers compute paths from
 * env vars at call time so tests can flip env without a module reset.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Cortex repo root. Falls back to two levels up from this file
 * (core/constants/ → repo root). Production always sets CORTEX_HOME explicitly;
 * the fallback only matters for no-env / test contexts. (Was `../../..` — one
 * level too high, resolving OUTSIDE the repo to CORTEX_HOME's parent; fixed
 * 2026-06-05 as part of the project-root reconcile.)
 */
export const CORTEX_HOME =
  process.env.CORTEX_HOME ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Default data root for the gateway DB and run-state files. Override via
 * `CORTEX_DATA_DIR`.
 */
export const DATA_DIR = process.env.CORTEX_DATA_DIR || path.join(CORTEX_HOME, 'data');

/**
 * Default workspace / projects root (per-project ledger dirs live here).
 * Canonical home is `<CORTEX_HOME>/projects/`; override via
 * `CORTEX_PROJECTS_DIR`.
 */
export const WORKSPACE_ROOT = process.env.CORTEX_PROJECTS_DIR
  || path.join(process.env.CORTEX_HUB_DIR || CORTEX_HOME, 'projects');

/**
 * Resolve the projects root. Canonical = `<CORTEX_HOME>/projects/`.
 *   1. $CORTEX_PROJECTS_DIR  (explicit override)
 *   2. $CORTEX_HUB_DIR/projects (launcher-pinned hub root)
 *   3. $CORTEX_HOME/projects    (fallback hub root)
 * Never derive this from $CORTEX_DATA_DIR; data/ is runtime state, while
 * projects/ is the ledger source-of-truth per docs/cortex-tree-layout.md.
 */
export function resolveProjectsRoot() {
  if (process.env.CORTEX_PROJECTS_DIR) return process.env.CORTEX_PROJECTS_DIR;
  // Read env at call time (honours this module's call-time-env contract).
  return path.join(process.env.CORTEX_HUB_DIR || process.env.CORTEX_HOME || CORTEX_HOME, 'projects');
}

/**
 * Alias retained for parity with `lib/task-files.js:resolveWorkspaceRoot`.
 */
export function resolveWorkspaceRoot() {
  return resolveProjectsRoot();
}

/**
 * State root — where sdk/auth/* persists identity, admin tokens, and the
 * credential envelope. Override via `CORTEX_STATE_ROOT`, else defaults to
 * `$CORTEX_DATA_DIR/state` when set, else `$CORTEX_HOME/state`.
 */
export function resolveStateRoot(override) {
  if (override) return override;
  if (process.env.CORTEX_STATE_ROOT) return process.env.CORTEX_STATE_ROOT;
  if (process.env.CORTEX_DATA_DIR) return path.join(process.env.CORTEX_DATA_DIR, 'state');
  return path.join(CORTEX_HOME, 'state');
}

/**
 * Log root — where sdk/logging/recovery.js buffers failed writes. Override
 * via `CORTEX_LOG_ROOT`, else defaults to `$CORTEX_DATA_DIR/logs` when set,
 * else `$CORTEX_HOME/logs`.
 */
export function resolveLogRoot(override) {
  if (override) return override;
  if (process.env.CORTEX_LOG_ROOT) return process.env.CORTEX_LOG_ROOT;
  if (process.env.CORTEX_DATA_DIR) return path.join(process.env.CORTEX_DATA_DIR, 'logs');
  return path.join(CORTEX_HOME, 'logs');
}

/**
 * Cache root — reserved for transient artifacts (Phase 3+ event archive).
 */
export function resolveCacheRoot(override) {
  if (override) return override;
  if (process.env.CORTEX_CACHE_ROOT) return process.env.CORTEX_CACHE_ROOT;
  if (process.env.CORTEX_DATA_DIR) return path.join(process.env.CORTEX_DATA_DIR, 'cache');
  return path.join(CORTEX_HOME, 'cache');
}
