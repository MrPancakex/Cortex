/**
 * scope-config.js
 *
 * Loads the scope-rules matrix (p2-scope-rules.json) and bearer-to-scope
 * assignments (bearer_scopes.json) at boot. Provides:
 *
 *   resolveScopeFromBearer(hash)  → scope name string, or "anon"
 *   getScopeRules(scopeName)      → rules array, or []
 *   reload()                      → re-read both files (call from SIGHUP handler)
 *
 * Path resolution:
 *   Matrix:      $CORTEX_SCOPE_RULES_PATH
 *                  → default: ~/Cortex/data/state/scope-rules.json  (canonical; no tmp fallback)
 *
 *   Assignments: $CORTEX_SCOPE_ASSIGNMENTS_PATH
 *                  → default: ~/Cortex/data/state/bearer_scopes.json
 *
 * Missing files are handled gracefully: the module logs a warning and
 * returns empty structures. The gateway will not crash on boot if the
 * matrix or assignments file is absent.
 *
 * SIGHUP: install one SIGHUP handler in the gateway's server.js and call
 * reload() from it. Do NOT install a new handler here — multiple handlers
 * on the same signal interfere with each other.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();

// Canonical = the gateway's own 2700 state dir. NO tmp/ fallback — a vital RBAC
// policy file must never load from clearable scratch (2026-06-09).
const CANONICAL_RULES_PATH = path.join(HOME, 'Cortex/data/state/scope-rules.json');
const DEFAULT_ASSIGNMENTS_PATH = path.join(HOME, 'Cortex/data/state/bearer_scopes.json');

function resolveRulesPath() {
  if (process.env.CORTEX_SCOPE_RULES_PATH) return process.env.CORTEX_SCOPE_RULES_PATH;
  return CANONICAL_RULES_PATH;
}

function resolveAssignmentsPath() {
  return process.env.CORTEX_SCOPE_ASSIGNMENTS_PATH || DEFAULT_ASSIGNMENTS_PATH;
}

/** @returns {{ [scopeName: string]: unknown[] }} */
function loadMatrix(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[scope-config] matrix file not found: ${filePath} — no scope rules loaded`);
    return {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeMatrix(raw);
  } catch (err) {
    console.warn(`[scope-config] failed to parse matrix file: ${err.message}`);
    return {};
  }
}

function normalizeMatrix(raw) {
  if (!raw || typeof raw !== 'object') return {};

  if (Array.isArray(raw.scopes)) {
    const matrix = {};
    for (const scope of raw.scopes) {
      if (!scope || typeof scope.name !== 'string') continue;
      matrix[scope.name] = Array.isArray(scope.permissions)
        ? scope.permissions
        : (Array.isArray(scope.rules) ? scope.rules : []);
    }
    return matrix;
  }

  // Accept both { scopes: { name: rules[] } } and { name: rules[] }.
  if (raw.scopes && typeof raw.scopes === 'object') return raw.scopes;
  return raw;
}

/** @returns {{ [bearerHash: string]: string }} */
function loadAssignments(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[scope-config] assignments file not found: ${filePath} — all tokens resolve to anon`);
    return {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const map = {};
    for (const entry of raw?.scope_assignments ?? []) {
      if (entry.bearer_hash && entry.scope) {
        map[entry.bearer_hash.toLowerCase()] = entry.scope;
      }
    }
    return map;
  } catch (err) {
    console.warn(`[scope-config] failed to parse assignments file: ${err.message}`);
    return {};
  }
}

// Module-level state — populated on first load and on reload().
let _matrix      = {};
let _assignments = {};

function load() {
  _matrix      = loadMatrix(resolveRulesPath());
  _assignments = loadAssignments(resolveAssignmentsPath());
}

// Boot-time load.
load();

/**
 * Resolve a scope name from a bearer hash.
 *
 * @param {string} bearerHash  — lowercase hex sha256 of the raw bearer token
 * @returns {string}           — scope name, or "anon" if not found
 */
export function resolveScopeFromBearer(bearerHash) {
  if (typeof bearerHash !== 'string' || bearerHash.length === 0) return 'anon';
  return _assignments[bearerHash.toLowerCase()] ?? 'anon';
}

/**
 * Whether the bearer hash has an EXPLICIT assignment in bearer_scopes.json.
 *
 * resolveScopeFromBearer() returns 'anon' for BOTH a missing assignment AND an
 * explicit `scope: "anon"` (an operator quarantine), so it cannot tell them
 * apart. Callers that fall back to a base/role scope when "no assignment exists"
 * MUST gate that fallback on this presence check — otherwise an intentional
 * anon/quarantine is silently upgraded back to base access (Task-90 round-8 #7
 * follow-up). Returns true only when the hash is an actual key in the loaded
 * assignment map (so an explicit `anon` is preserved, a missing one is not).
 *
 * @param {string} bearerHash — lowercase hex sha256 of the raw bearer token
 * @returns {boolean}
 */
export function hasBearerAssignment(bearerHash) {
  if (typeof bearerHash !== 'string' || bearerHash.length === 0) return false;
  return Object.prototype.hasOwnProperty.call(_assignments, bearerHash.toLowerCase());
}

/**
 * Return the rules array for a scope.
 *
 * @param {string} scopeName
 * @returns {unknown[]}
 */
export function getScopeRules(scopeName) {
  if (typeof scopeName !== 'string') return [];
  return _matrix[scopeName] ?? [];
}

/**
 * Re-read both files from disk. Call this from the gateway's SIGHUP handler
 * (do not install a separate SIGHUP listener inside this module).
 */
export function reload() {
  load();
}
