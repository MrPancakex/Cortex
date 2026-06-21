/**
 * On-disk token-registry loader. Reads the JSON file the legacy
 * gateway already used as the canonical token source
 * (`token-registry.json`), validates its shape + duplicate-hash
 * invariant, and returns a `{ agents: { [id]: { hash, role?, base?,
 * platform? } } }` object suitable for the gate plane's
 * `writeRegistrySnapshot()`.
 *
 * Why a file loader: the gate auth middleware's `resolveSubject()`
 * reads from the `gate_registry_snapshot` DB row. Nothing hydrates
 * that row at cold boot — the end-to-end review flagged this as the
 * reason the real process can boot with a valid on-disk token setup
 * and treat every caller as anonymous. The composer calls this loader
 * + `writeRegistrySnapshot()` at startup so prod boot has the same
 * registry view the tests hand-seed.
 *
 * File location:
 *   1. `CORTEX_TOKEN_REGISTRY` env override, else
 *   2. `$CORTEX_STATE_ROOT/token-registry.json`, else
 *   3. `$CORTEX_DATA_DIR/state/token-registry.json`, else
 *   4. `$CORTEX_HOME/state/token-registry.json`.
 *
 * Returns an empty registry (`{ agents: {} }`) when the file is absent —
 * fresh boots before `cortex init` has seeded any agents. Throws only
 * for MALFORMED content (invalid JSON, duplicate hashes, missing
 * required fields) because silently booting with a quietly-corrupt
 * registry is the same silent-corrupt failure mode this loader was designed to prevent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveStateRoot } from '@cortex/core/constants';
import { swallow } from '../errors/index.js';

const DEFAULT_FILENAME = 'token-registry.json';

/**
 * Resolve the absolute path to the registry file. Pure — no I/O.
 */
export function resolveTokenRegistryPath(override) {
  if (override) return override;
  if (process.env.CORTEX_TOKEN_REGISTRY) return process.env.CORTEX_TOKEN_REGISTRY;
  return path.join(resolveStateRoot(), DEFAULT_FILENAME);
}

/**
 * Read + validate the on-disk registry.
 *
 * @param {{ path?: string }} [opts]
 * @returns {{ agents: Record<string, {hash: string, role?: string, base?: string, platform?: string}> }}
 */
export function loadTokenRegistryFile(opts = {}) {
  const filePath = resolveTokenRegistryPath(opts.path);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { agents: {} };
    swallow('auth.token_registry_read_failed', err);
    return { agents: {} };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = `token-registry.json is not valid JSON at ${filePath}: ${err.message}`;
    swallow('auth.token_registry_parse_failed', err);
    throw new Error(msg);
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.agents || typeof parsed.agents !== 'object') {
    throw new Error(`token-registry.json missing "agents" object at ${filePath}`);
  }

  // Duplicate-hash check — two agents sharing a hash is a catastrophic
  // identity collision (an attacker holding one agent's token could
  // authenticate as the other). Matches the legacy assertRegistryShape
  // invariant.
  const seen = new Map();
  for (const [id, config] of Object.entries(parsed.agents)) {
    if (!config || typeof config !== 'object') {
      throw new Error(`token-registry.json: agent "${id}" has no config object`);
    }
    const hash = config.hash;
    if (typeof hash !== 'string' || hash.length === 0) {
      throw new Error(`token-registry.json: agent "${id}" has no hash`);
    }
    if (seen.has(hash)) {
      throw new Error(
        `token-registry.json: duplicate token hash across agents "${seen.get(hash)}" and "${id}"`,
      );
    }
    seen.set(hash, id);
  }

  return parsed;
}
