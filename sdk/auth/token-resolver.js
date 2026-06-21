import { readFileSync as _readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uniqueVaultCandidates, vaultCandidates } from './slot.js';

export const TOKEN_LINE_RE = /^(?:CORTEX_REVIEWER_TOKEN|CORTEX_AGENT_TOKEN|CORTEX_BEARER)=(.+)$/m;
export const DEFAULT_TOKEN_DIR = '/etc/cortex/agents';
export const CANONICAL_TOKEN_DIR = path.join(os.homedir(), '.cortex', 'keys');

/**
 * Resolve an agent bearer token using the canonical fallback chain.
 *
 * Resolution order:
 *   1. env.CORTEX_AGENT_TOKEN / env.CORTEX_BEARER — explicit env value.
 *   2. env.CORTEX_TOKEN_FILE / env.CORTEX_AGENT_TOKEN_FILE — explicit file path.
 *   3. env.CORTEX_TOKEN_DIR/<id|base>.env when set to a non-default dir.
 *   4. ~/.cortex/keys/<id|base>.env (canonical vault).
 *   5. /etc/cortex/agents/<id|base>.env (legacy vault; last resort).
 *
 * For steps 3-5 each vault dir is probed EXACT-id-first, then the peeled BASE:
 * a standalone registered `nova-2` (its own `nova-2.env`) resolves its exact
 * keyfile, while a session-slot `nova-2` (no `nova-2.env`, token shared with
 * the base) misses the exact candidate and falls through to `nova.env`. For a
 * bare base id exact === base, so the chain collapses to one path per dir. An
 * explicit `candidates` override bypasses this entirely (the caller owns those
 * paths).
 *
 * File format: lines matching
 * `^(?:CORTEX_REVIEWER_TOKEN|CORTEX_AGENT_TOKEN|CORTEX_BEARER)=(.+)$`.
 * First matching line wins; no key-name precedence — order in file decides.
 * Commented-out tokens (lines not anchored at column 0) are never matched.
 *
 * Implicit chain (steps 3-5): readFile failures are swallowed individually;
 * only total failure throws. Explicit file (step 2): any failure throws.
 *
 * @param {object} opts
 * @param {string}   opts.baseAgent    - Agent id, e.g. 'nova'
 * @param {object}   [opts.env]        - Env object; defaults to process.env
 * @param {string[]} [opts.candidates] - Override implicit file chain (steps 3-5)
 * @param {Function} [opts.readFileFn] - Override fs.readFileSync for testing
 * @param {Function} [opts.swallowFn]  - Called as swallowFn(metric, err) on each
 *                                       swallowed failure; defaults to no-op
 * @returns {string} Trimmed token
 * @throws {Error} When no token source yields a value
 */
export function resolveAgentToken({
  baseAgent,
  env = process.env,
  candidates = null,
  readFileFn = _readFileSync,
  swallowFn = () => {},
}) {
  if (!baseAgent) throw new Error('resolveAgentToken: baseAgent is required');

  const explicit = env.CORTEX_AGENT_TOKEN || env.CORTEX_BEARER;
  if (explicit) return explicit.trim();

  const explicitFile = env.CORTEX_TOKEN_FILE || env.CORTEX_AGENT_TOKEN_FILE;
  if (explicitFile) {
    return resolveExplicitFile(explicitFile, readFileFn, swallowFn);
  }

  // Default vault filenames are probed EXACT-id-first, then the peeled BASE,
  // per dir (deduped): a standalone `nova-2` finds `nova-2.env`; a session
  // slot `nova-2` (no exact keyfile) falls through to `nova.env`. An explicit
  // `candidates` override is used verbatim — the caller owns those paths.
  const implicitChain = candidates ?? buildImplicitTokenCandidates(baseAgent, env);

  return resolveImplicitChain(implicitChain, baseAgent, readFileFn, swallowFn);
}

export function buildImplicitTokenCandidates(baseAgent, env = process.env) {
  return uniqueVaultCandidates(
    [
      env.CORTEX_TOKEN_DIR && env.CORTEX_TOKEN_DIR !== DEFAULT_TOKEN_DIR
        ? env.CORTEX_TOKEN_DIR
        : null,
      CANONICAL_TOKEN_DIR,
      DEFAULT_TOKEN_DIR,
    ],
    baseAgent,
  );
}

export { vaultCandidates };

function resolveExplicitFile(filePath, readFileFn, swallowFn) {
  let content;
  try {
    content = readFileFn(filePath, 'utf8');
  } catch (err) {
    swallowFn('auth.token_load_failed', err);
    throw err;
  }
  const match = matchTokenLine(content);
  if (match) return match[1].trim();
  const err = new Error(`CORTEX_REVIEWER_TOKEN/CORTEX_AGENT_TOKEN/CORTEX_BEARER not found in ${filePath}`);
  swallowFn('auth.token_load_failed', err);
  throw err;
}

function resolveImplicitChain(chain, baseAgent, readFileFn, swallowFn) {
  let lastErr;
  let lastPath;
  for (const tokenFile of chain) {
    let content;
    try {
      content = readFileFn(tokenFile, 'utf8');
    } catch (err) {
      swallowFn('auth.token_load_failed', err);
      lastErr = err;
      lastPath = tokenFile;
      continue;
    }
    const match = matchTokenLine(content);
    if (match) return match[1].trim();
    lastErr = new Error(`CORTEX_REVIEWER_TOKEN/CORTEX_AGENT_TOKEN/CORTEX_BEARER not found in ${tokenFile}`);
    lastPath = tokenFile;
  }
  const finalErr = lastErr ?? new Error(`no token source available for agent '${baseAgent}'`);
  if (lastPath && !finalErr.message.includes(lastPath)) {
    const wrapped = new Error(`${finalErr.message} (last tried: ${lastPath})`);
    swallowFn('auth.token_load_failed', wrapped);
    throw wrapped;
  }
  swallowFn('auth.token_load_failed', finalErr);
  throw finalErr;
}

function matchTokenLine(content) {
  const reviewer = content.match(/^CORTEX_REVIEWER_TOKEN=(.+)$/m);
  if (reviewer) return reviewer;
  return content.match(/^(?:CORTEX_AGENT_TOKEN|CORTEX_BEARER)=(.+)$/m);
}
