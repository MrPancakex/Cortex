/**
 * RBAC auth/check endpoint.
 *
 * GET /v1/api/auth/check?path=<encoded>&action=<read|write|delete>
 * Authorization: Bearer <agent-bearer>
 *
 * Loads the scope matrix from ~/Cortex/data/state/scope-rules.json
 * once on boot, caches in memory, and reloads on SIGHUP.
 *
 * Rule evaluation:
 *   1. Deny rules (action:"deny" in the rule's actions array) → evaluated first.
 *      Only fires when the requested action matches the rule's action list
 *      OR when the rule has action:"deny" (which is a blanket deny for all actions).
 *   2. Allow rules (action in ["read","write","delete"]) → evaluated if no deny matched.
 *   3. No match → default deny per _meta.default:"deny".
 *
 * NOTE: The secondary write-only-deny carve-outs (e.g. an agent's scoped write deny)
 * use actions:["write"] WITHOUT a "deny" sentinel. These are enforced because we detect
 * "deny" blocks by the presence of "deny" in the actions array AND by position (first
 * permission block per scope). Any rule with "deny" in actions is treated as a deny rule.
 * Rules without "deny" that appear in DENY (_comment) blocks but use specific action names
 * (like ["write"]) are detected as secondary deny rules per the _comment prefix.
 * See evaluateAccess for details.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { swallow } from '@cortex/sdk/errors';
import { emit as _emitEvent } from '@cortex/sdk/events';

// -- Matrix loading ----------------------------------------------------------

// F-03 + 2026-06-09: both auth planes (bearer→scope mapping and path→allow
// evaluation) read the SAME on-disk file. Canonical = ~/Cortex/data/state/
// scope-rules.json (the gateway's own 2700 state dir). NO tmp/ fallback — a
// vital RBAC policy file must never load from clearable scratch; fail closed
// (default-deny via _matrixLoadFailed) if the canonical file is missing.
const HOME = os.homedir();
const CANONICAL_RULES_PATH = path.join(HOME, 'Cortex/data/state/scope-rules.json');

function resolveDefaultMatrixPath() {
  if (process.env.CORTEX_SCOPE_RULES_PATH) return process.env.CORTEX_SCOPE_RULES_PATH;
  return CANONICAL_RULES_PATH;
}

let _cachedMatrix = null;
let _matrixPath = null; // resolved lazily on first load

// F-04: Track whether the last matrix load succeeded.
let _matrixLoadFailed = false;

/** Load and normalize the scope matrix into a fast-lookup structure. */
function loadMatrix(filePath) {
  const resolvedPath = filePath ?? _matrixPath ?? resolveDefaultMatrixPath();
  try {
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const json = JSON.parse(raw);
    _matrixLoadFailed = false;
    return normalizeMatrix(json);
  } catch (err) {
    _matrixLoadFailed = true;
    swallow('auth.check.matrix_load_failed', err);
    // F-04: emit a high-severity log message visible to operators.
    try {
      const log = globalThis.__cortex_log;
      if (log && typeof log.error === 'function') {
        log.error(
          { path: resolvedPath, code: err?.code, message: err?.message },
          '[RBAC] HIGH: scope matrix failed to load — all auth/check requests will default-deny',
        );
      } else {
        process.stderr.write(
          `[auth.check.matrix_load_failed] HIGH: scope matrix failed to load at ${resolvedPath}: ${err?.message}\n`,
        );
      }
    } catch { /* ignore logger errors */ }
    // F-04: emit system event so the event bus records the failure for operators.
    // Guard with try/catch — DB may not be ready on early boot.
    try {
      _emitEvent('system.matrix_load_failed', {
        path: resolvedPath,
        code: err?.code,
        message: err?.message,
        timestamp: Date.now(),
      });
    } catch { /* DB not ready or bus unavailable — swallow is already recorded above */ }
    return { scopes: {}, default: 'deny' };
  }
}

/** Return true if the last matrix load attempt failed. Used by /health. */
export function isMatrixLoadFailed() {
  // Trigger lazy load so the flag is populated before anyone checks it.
  if (!_cachedMatrix) getMatrix();
  return _matrixLoadFailed;
}

/**
 * Normalize the raw JSON into a map of scopeName → [{effect, paths, actions}].
 * Effect is derived: if actions array contains "deny" → effect is "deny".
 * If _comment starts with "DENY" → also treat as deny (for write-only carve-outs).
 * Otherwise → effect is "allow".
 */
function normalizeMatrix(json) {
  const result = { scopes: {}, default: json._meta?.default ?? 'deny' };
  for (const scope of (json.scopes ?? [])) {
    const rules = [];
    for (const perm of (scope.permissions ?? [])) {
      const hasDenyAction = Array.isArray(perm.actions) && perm.actions.includes('deny');
      const commentIsDeny = typeof perm._comment === 'string'
        && perm._comment.toUpperCase().startsWith('DENY');
      const effect = hasDenyAction || commentIsDeny ? 'deny' : 'allow';
      rules.push({
        effect,
        paths: Array.isArray(perm.paths) ? perm.paths : [],
        // For deny rules with actions:["deny"], treat as matching ALL actions.
        // For write-only deny rules (effect=deny, actions:["write"]), match only those actions.
        actions: hasDenyAction ? ['read', 'write', 'delete'] : (perm.actions ?? []),
      });
    }
    result.scopes[scope.name] = rules;
  }
  return result;
}

/** Get (and lazy-load) the cached matrix. */
export function getMatrix() {
  if (!_cachedMatrix) {
    _cachedMatrix = loadMatrix();
  }
  return _cachedMatrix;
}

/** Force-reload the matrix (called on SIGHUP, tests, etc.). */
export function reloadMatrix(filePath) {
  if (filePath) _matrixPath = filePath;
  _cachedMatrix = loadMatrix(_matrixPath ?? resolveDefaultMatrixPath());
  return _cachedMatrix;
}

/** Reset for tests. */
export function resetMatrixForTests() {
  _cachedMatrix = null;
  _matrixPath = null;
  _matrixLoadFailed = false;
}

// -- Path normalization ------------------------------------------------------

const INJECT_RE = /[\0\n\r]/;

/**
 * Normalize a path for matching:
 *   1. Reject null bytes, newlines, carriage returns (injection guard).
 *   2. Attempt fs.realpathSync (resolves symlinks + ../..).
 *   3. On ENOENT fall back to path.resolve (lexical normalization).
 *      F-14: In the ENOENT fallback, walk each ancestor component with
 *      lstatSync. If ANY existing ancestor is a symlink, reject with
 *      invalid_path — the final target is unreachable but the symlink
 *      component itself could point into a protected location.
 * Returns { ok: true, normalized } or { ok: false, reason }.
 */
export function normalizePath(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { ok: false, reason: 'invalid_path' };
  }
  if (INJECT_RE.test(inputPath)) {
    return { ok: false, reason: 'invalid_path' };
  }
  // Must be absolute.
  if (!path.isAbsolute(inputPath)) {
    return { ok: false, reason: 'invalid_path' };
  }
  try {
    const resolved = fs.realpathSync(inputPath);
    return { ok: true, normalized: resolved };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      // F-14: Check for symlink ancestors before accepting lexical resolution.
      // A symlink component can redirect the path to a protected location even
      // when the final target doesn't exist yet.
      if (_hasSymlinkAncestor(inputPath)) {
        return { ok: false, reason: 'invalid_path' };
      }
      // Lexical resolution: resolve .. and . without following symlinks.
      return { ok: true, normalized: path.resolve(inputPath) };
    }
    return { ok: false, reason: 'invalid_path' };
  }
}

/**
 * Walk each prefix component of the path from root to leaf.
 * Return true if any existing component is a symlink.
 * Stops walking at the first non-existent component (the ENOENT segment).
 *
 * @param {string} inputPath — absolute path
 * @returns {boolean}
 */
function _hasSymlinkAncestor(inputPath) {
  const segments = inputPath.split(path.sep).filter(Boolean);
  let current = path.sep;
  for (const seg of segments) {
    current = path.join(current, seg);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return true;
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') break; // path stops existing here
      break; // other errors: don't block, treat as no-symlink-found
    }
  }
  return false;
}

// -- Glob matcher ------------------------------------------------------------

/**
 * Match a path against a glob pattern.
 * Supports:
 *   **  — matches ONE or more path segments (recursive). F-20: `path/**` does
 *         NOT match the bare `path` — use `path` or `path/` for that.
 *   *   — matches exactly one path segment (no slashes)
 *
 * Both pattern and target must be absolute paths.
 */
export function globMatch(pattern, target) {
  // Normalize trailing slashes for comparison.
  const p = pattern.replace(/\/+$/, '');
  const t = target.replace(/\/+$/, '');

  if (p === t) return true;

  const pSegs = p.split('/');
  const tSegs = t.split('/');

  return matchSegs(pSegs, tSegs, 0, 0);
}

function matchSegs(pSegs, tSegs, pi, ti) {
  while (pi < pSegs.length && ti < tSegs.length) {
    const ps = pSegs[pi];
    if (ps === '**') {
      // F-20: ** matches ONE or more segments (not zero). skip starts at 1.
      // This means `path/**` does NOT match bare `path`; it requires at least
      // one segment after the parent. To match the dir itself, use `path` directly.
      for (let skip = 1; skip <= tSegs.length - ti; skip++) {
        if (matchSegs(pSegs, tSegs, pi + 1, ti + skip)) return true;
      }
      return false;
    }
    if (ps === '*') {
      // * matches exactly one segment (any value).
      pi++;
      ti++;
      continue;
    }
    if (ps !== tSegs[ti]) return false;
    pi++;
    ti++;
  }
  // F-20: do NOT consume trailing ** segments for zero-segment match.
  // `path/**` requires at least one segment after `path`, so a trailing **
  // with no remaining target segments is NOT a match.
  return pi === pSegs.length && ti === tSegs.length;
}

// -- Scope resolution --------------------------------------------------------

/** Derive the scope name from ctx.actor (populated by auth-middleware).
 * F-02: prefer actor.scope (set from subject.scope which carries bearer_scopes.json
 * + grant elevation), fall back to actor.base, then 'anon'.
 */
export function resolveScope(actor) {
  if (!actor || actor.kind === 'anon') return 'anon';
  if (actor.kind === 'admin') return 'admin';
  // kind === 'agent' — prefer elevated/bearer scope, fall back to base name.
  return actor.scope ?? actor.base ?? 'anon';
}

// -- RBAC disable switch ------------------------------------------------------

const RBAC_DISABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** Return true when the RBAC auth/check evaluator should allow everything. */
export function isRbacDisabled() {
  return RBAC_DISABLED_VALUES.has(String(process.env.CORTEX_RBAC_DISABLED || '').trim().toLowerCase());
}

function allowBecauseRbacDisabled(scope) {
  return {
    allowed: true,
    scope,
    rule_matched: '__rbac_disabled__',
    reason: 'rbac_disabled',
  };
}

// -- Rule evaluation ---------------------------------------------------------

const VALID_ACTIONS = new Set(['read', 'write', 'delete']);

/**
 * Pure evaluation function — decoupled from HTTP for testability.
 *
 * @param {{
 *   scope: string,
 *   path: string,           // already normalized absolute path
 *   action: 'read'|'write'|'delete',
 *   matrix?: object,        // injected for tests; defaults to cached matrix
 *   channel?: 'tcp'|'unix', // for admin TCP check
 * }} opts
 * @returns {{ allowed: boolean, scope: string, rule_matched: string, reason?: string }}
 */
export function evaluateAccess({ scope, path: targetPath, action, matrix, channel = 'tcp' }) {
  if (isRbacDisabled()) {
    return allowBecauseRbacDisabled(scope);
  }

  const m = matrix ?? getMatrix();
  const scopeRules = m.scopes?.[scope];

  // Admin scope: TCP channel is categorically denied before matrix evaluation.
  if (scope === 'admin' && channel !== 'unix') {
    return {
      allowed: false,
      scope,
      rule_matched: '__tcp_channel__ deny',
      reason: 'admin_scope_requires_unix_socket',
    };
  }

  // Anon scope: check for virtual HTTP route allows first.
  if (scope === 'anon') {
    return evaluateAnonScope(targetPath, action, m);
  }

  if (!scopeRules) {
    return { allowed: false, scope, rule_matched: 'no_rules', reason: 'default:deny' };
  }

  // Pass 1: deny rules.
  for (const rule of scopeRules) {
    if (rule.effect !== 'deny') continue;
    if (!rule.actions.includes(action)) continue;
    for (const pat of rule.paths) {
      if (globMatch(pat, targetPath)) {
        return {
          allowed: false,
          scope,
          rule_matched: pat,
          reason: `deny:${pat}`,
        };
      }
    }
  }

  // Pass 2: allow rules.
  for (const rule of scopeRules) {
    if (rule.effect !== 'allow') continue;
    if (!rule.actions.includes(action)) continue;
    for (const pat of rule.paths) {
      if (globMatch(pat, targetPath)) {
        return { allowed: true, scope, rule_matched: pat };
      }
    }
  }

  // Default deny.
  return { allowed: false, scope, rule_matched: 'default', reason: 'default:deny' };
}

/**
 * Server-side mutation-authorization gate (Plan C).
 *
 * Coarse decision the gateway dispatcher runs on every API/MCP MUTATION
 * (POST/PATCH/PUT/DELETE), BEFORE the route handler — so enforcement is
 * real at the gateway and does NOT depend on any client-side hook calling
 * /v1/api/auth/check. Distinct from evaluateAccess (the per-fs-path matcher
 * the hook uses): this answers "is the caller a recognized, matrix-backed
 * scope allowed to mutate at all".
 *
 *   - RBAC disabled (env escape hatch)            → allow (parity w/ evaluateAccess).
 *   - matrix failed to load                       → DENY (fail-closed): a vital
 *                                                    policy file being unreadable
 *                                                    must never silently open writes.
 *   - scope is anon / absent / not in the matrix  → DENY (under-scoped identity).
 *   - scope is a known non-anon scope in matrix   → ALLOW (authorized).
 *
 * @param {{
 *   scope: string,
 *   matrix?: object,        // injected for tests; defaults to cached matrix
 *   matrixFailed?: boolean, // injected for tests; defaults to isMatrixLoadFailed()
 * }} opts
 * @returns {{ allowed: boolean, scope: string, reason: string }}
 */
export function evaluateApiMutation({ scope, matrix, matrixFailed }) {
  if (isRbacDisabled()) {
    return { allowed: true, scope, reason: 'rbac_disabled' };
  }
  const failed = matrixFailed ?? isMatrixLoadFailed();
  if (failed) {
    return { allowed: false, scope, reason: 'matrix_unavailable' };
  }
  if (!scope || scope === 'anon') {
    return { allowed: false, scope, reason: 'scope_not_authorized' };
  }
  const m = matrix ?? getMatrix();
  const scopeRules = m?.scopes?.[scope];
  if (!scopeRules) {
    return { allowed: false, scope, reason: 'scope_not_authorized' };
  }
  return { allowed: true, scope, reason: 'authorized' };
}

/**
 * Anon scope uses virtual __http_route__ entries for allow, denies everything else.
 *
 * F-15: Denial results include `path`, `action`, `attempted_scope`, and `actual_scope`
 * fields so operators can diagnose what was denied without tailing the logs.
 */
function evaluateAnonScope(targetPath, action, m) {
  const scopeRules = m.scopes?.['anon'] ?? [];

  // Deny rules first (filesystem deny blocks).
  for (const rule of scopeRules) {
    if (rule.effect !== 'deny') continue;
    if (!rule.actions.includes(action)) continue;
    for (const pat of rule.paths) {
      if (!pat.startsWith('__') && globMatch(pat, targetPath)) {
        return {
          allowed: false,
          scope: 'anon',
          rule_matched: pat,
          reason: `deny:${pat}`,
          // F-15: audit detail for anon denials
          path: targetPath,
          action,
          attempted_scope: 'anon',
          actual_scope: 'anon',
        };
      }
    }
  }

  // Allow: check __http_route__ entries for read action.
  if (action === 'read') {
    for (const rule of scopeRules) {
      if (rule.effect !== 'allow') continue;
      for (const pat of rule.paths) {
        if (pat.startsWith('__http_route__:')) {
          // Extract the HTTP path from __http_route__:METHOD:PATH.
          const parts = pat.split(':');
          const routePath = parts.slice(2).join(':');
          if (routePath === targetPath || globMatch(routePath, targetPath)) {
            return { allowed: true, scope: 'anon', rule_matched: pat };
          }
        }
      }
    }
  }

  return {
    allowed: false,
    scope: 'anon',
    rule_matched: 'default',
    reason: 'default:deny',
    // F-15: audit detail for anon default-deny
    path: targetPath,
    action,
    attempted_scope: 'anon',
    actual_scope: 'anon',
  };
}

// -- HTTP handler ------------------------------------------------------------

function ok(body) {
  return { status: 200, body };
}

function fail(code, status = 400) {
  return { status, body: { error: code } };
}

/**
 * Handler for GET /v1/api/auth/check
 * ctx shape: { query: { path, action }, actor: { kind, base, id } }
 */
export function authCheckHandler(ctx) {
  const actor = ctx?.actor;

  // 401 when no valid actor (anon due to missing/invalid token is ok; anon due to
  // explicit auth failure is still 401? spec says 401 = unauthorized. Anon with
  // no token is allowed to hit the endpoint to check public paths).
  // We always let the request through to evaluation; anon is a valid scope.

  const rawPath = ctx?.query?.path ?? (ctx?.url ? new URL(ctx.url, 'http://x').searchParams.get('path') : null);
  const action = ctx?.query?.action ?? (ctx?.url ? new URL(ctx.url, 'http://x').searchParams.get('action') : null);

  if (!rawPath) return fail('invalid_path');
  if (!action || !VALID_ACTIONS.has(action)) return fail('invalid_action');

  // Must be authenticated to get a meaningful response (anon is OK but 401 if
  // actor is explicitly undefined due to broken auth).
  if (actor === undefined) return fail('unauthorized', 401);

  const norm = normalizePath(rawPath);
  if (!norm.ok) return fail('invalid_path');

  const scope = resolveScope(actor);
  const channel = ctx?.channel ?? 'tcp';

  if (isRbacDisabled()) return ok(allowBecauseRbacDisabled(scope));

  const result = evaluateAccess({
    scope,
    path: norm.normalized,
    action,
    channel,
  });

  return ok(result);
}

// -- Route mount -------------------------------------------------------------

/**
 * @param {{ add: (method: string, path: string, handler: Function) => void }} adapter
 * @param {{ matrixPath?: string }} [opts]
 */
export function mountAuthRoutes(adapter, opts = {}) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('mountAuthRoutes: adapter must expose add(method, path, handler)');
  }
  if (opts.matrixPath) {
    reloadMatrix(opts.matrixPath);
  }
  adapter.add('GET', '/v1/api/auth/check', authCheckHandler);
}
