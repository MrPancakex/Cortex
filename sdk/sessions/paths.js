/**
 * Path resolution for the session-lease directory and per-slot lease
 * files. Pure — no I/O. Lifted from services/gateway/lib/session.js
 * per Rule 1.
 *
 * `defaultRunDir()` precedence: $CORTEX_RUN_DIR → $CORTEX_HOME/data/run
 * → repoRoot/data/run. No silent fallback to $HOME — callers are expected
 * to surface write failures rather than pick a surprising location.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function defaultRunDir() {
  if (process.env.CORTEX_RUN_DIR) return process.env.CORTEX_RUN_DIR;
  if (process.env.CORTEX_HOME) return join(process.env.CORTEX_HOME, 'data', 'run');
  // This file lives at sdk/sessions/paths.js; rebuild root is two levels up
  // (sdk/sessions → sdk → rebuild-root). Callers that need a non-repo-relative
  // location should set CORTEX_RUN_DIR or CORTEX_HOME above.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'data', 'run');
}

export function leasePath(runDir, baseId, n) {
  return `${runDir}/${baseId}-${n}.session.json`;
}
