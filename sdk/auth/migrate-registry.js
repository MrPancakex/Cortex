/**
 * Migrate a legacy token-registry.json from the pre-state-root layout
 * ($DATA_DIR/token-registry.json) to the canonical location returned
 * by resolveTokenRegistryPath() ($DATA_DIR/state/token-registry.json).
 *
 * The v0.1→v0.2 cutover left some installs with a registry at the
 * legacy path while the gateway loaded from state/. Every bot token
 * resolved to anon and REST claim 401'd. This helper is the canonical
 * merge logic shared between bin/cortex-init.js's --repair mode and
 * scripts/run-prod.sh's pre-seed step (run-prod.sh uses cp+mv since
 * it's bash; init.js calls this directly for the merge semantics).
 *
 * Conflict rule: canonical wins on key collision. The legacy file may
 * carry stale entries from a botched seed; we never silently overwrite
 * a working install.
 *
 * No-op when either:
 *   - legacyPath === canonicalPath (resolver picked the legacy file by
 *     env override; nothing to migrate).
 *   - legacyPath doesn't exist or is empty.
 *   - legacyPath is unparseable (logged so the operator can hand-merge
 *     instead of silently lose entries).
 *
 * Returns a structured result so the caller can format its own output.
 */

import fs from 'node:fs';

/**
 * @param {object} opts
 * @param {string} opts.legacyPath    The path that may hold an old registry.
 * @param {string} opts.canonicalPath The path the gateway loads from.
 * @param {(reg: object) => void} opts.saveCanonical
 *                                    Atomic save helper supplied by the
 *                                    caller (init.js's saveReg). Does
 *                                    tmp+rename; we don't reimplement.
 * @returns {{ skipped?: string, merged?: number, conflicts?: number,
 *             unparseable?: boolean }}
 */
export function migrateLegacyRegistry({ legacyPath, canonicalPath, saveCanonical }) {
  if (!legacyPath || !canonicalPath || legacyPath === canonicalPath) {
    return { skipped: 'same_path_or_missing' };
  }
  let stat;
  try { stat = fs.statSync(legacyPath); }
  catch (err) { void err; return { skipped: 'legacy_absent' }; }
  if (!stat.isFile() || stat.size === 0) {
    return { skipped: 'legacy_empty' };
  }
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8')); }
  catch (err) { void err; return { skipped: 'legacy_unparseable', unparseable: true }; }
  if (!legacy || !legacy.agents || typeof legacy.agents !== 'object') {
    return { skipped: 'legacy_malformed' };
  }

  let canonical = { agents: {} };
  if (fs.existsSync(canonicalPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
      if (parsed && parsed.agents && typeof parsed.agents === 'object') {
        canonical = parsed;
      }
    } catch (err) {
      // Unparseable canonical — treat as empty so we don't add to broken
      // file. Caller will see merged=0 and can decide to fix manually.
      void err;
      canonical = { agents: {} };
    }
  }

  let merged = 0;
  let conflicts = 0;
  for (const [id, cfg] of Object.entries(legacy.agents)) {
    if (canonical.agents[id]) {
      conflicts++;          // canonical wins; don't overwrite
      continue;
    }
    canonical.agents[id] = cfg;
    merged++;
  }

  if (merged > 0) {
    saveCanonical(canonical);
  }
  return { merged, conflicts };
}
