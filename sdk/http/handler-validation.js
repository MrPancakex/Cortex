/**
 * handler-validation.js — lightweight argument guards for MCP handlers
 * and HTTP route handlers. Lifted from `services/gateway/lib/handler-validation.js`
 * per Rule 1 (downward-only dependency) — the helpers are used by both the
 * gateway tool handlers and by session hooks, so they belong in sdk/http.
 *
 * Three exports:
 *   - validateRequired(args, fields) — throws Error('X is required') if any
 *     field is missing/null/undefined/empty-string.
 *   - validateEnum(name, value, allowed) — throws Error('X must be one of …')
 *     when value is not in the allowed set. Skips the check when value is
 *     null/undefined so callers can layer it with validateRequired.
 *   - validateArray(name, value, { maxLength }) — asserts value is an array
 *     and (optionally) enforces a maximum length. Skips when value is
 *     null/undefined.
 */

export function validateRequired(args, fields) {
  const source = args || {};
  for (const field of fields) {
    const v = source[field];
    if (v === undefined || v === null || v === '') {
      throw new Error(`${field} is required`);
    }
  }
}

export function validateEnum(name, value, allowed) {
  if (value === undefined || value === null) return;
  const set = Array.isArray(allowed) ? new Set(allowed) : allowed;
  if (!set.has(value)) {
    const list = Array.isArray(allowed) ? allowed.join(', ') : Array.from(set).join(', ');
    throw new Error(`${name} must be one of: ${list}`);
  }
}

export function validateArray(name, value, { maxLength } = {}) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (typeof maxLength === 'number' && value.length > maxLength) {
    throw new Error(`${name} exceeds maximum length ${maxLength}`);
  }
}
