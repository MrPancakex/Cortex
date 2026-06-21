/**
 * Fine-grained permission grants. Complements the policy engine:
 *   - Policies answer "is this subject+action+resource allowed at all?"
 *   - Permissions answer "does this subject have permission X on
 *     resource Y?"
 *
 * Grants are stored in gate_permissions as
 *   (subject_id, permission, resource_kind, resource_id, granted_at,
 *    expires_at)
 * and loaded on demand — no cache here because grants are infrequent
 * and short (the typical surface is per-task or per-project).
 *
 * The module exposes direct has / grant / revoke / list helpers plus a
 * middleware factory for the adapter pattern the gateway uses.
 */

import { swallow } from '@cortex/sdk/errors';
import { parseGatePermission } from '../../../core/schemas/gate.js';
import { getGateStatements } from './statements.js';

// Sentinel used on disk when no resource scope is attached. SQLite's
// PRIMARY KEY treats NULL columns as always-distinct, so storing raw
// NULL would let a caller grant the same (subject, permission, NULL,
// NULL) tuple twice and never have the ON CONFLICT clause fire. The
// sentinel keeps the PK working as a proper uniqueness constraint.
const UNSCOPED = '*';

function normaliseScope(kind, id) {
  return {
    kind: kind == null || kind === '' ? UNSCOPED : kind,
    id: id == null || id === '' ? UNSCOPED : id,
  };
}

function denormaliseScope(kind, id) {
  return {
    resource_kind: kind === UNSCOPED ? null : kind,
    resource_id: id === UNSCOPED ? null : id,
  };
}

/**
 * Does the subject have the named permission on the optional
 * (resource_kind, resource_id) tuple? A scoped grant matches only its
 * exact (kind, id) tuple; an unscoped grant (passed in as null/null,
 * stored as (*, *)) matches queries that are themselves unscoped OR
 * that supply any (kind, id) — the unscoped grant "covers" the
 * specific lookup because it represents a broad grant.
 *
 * Lookup order: exact match first, then unscoped-grant fallback.
 */
export function hasPermission({
  subjectId,
  permission,
  resourceKind = null,
  resourceId = null,
  now = Date.now(),
}) {
  try {
    if (!subjectId || !permission) return false;
    const stmts = getGateStatements();
    const target = normaliseScope(resourceKind, resourceId);
    // 1. Exact (kind, id) match.
    const exact = stmts.findPermission.get(
      subjectId, permission,
      target.kind, target.kind,
      target.id, target.id,
    );
    if (exact && !isExpired(exact, now)) return true;
    // 2. Unscoped grant fallback — covers every (kind, id) lookup for
    //    this subject + permission.
    if (target.kind !== UNSCOPED || target.id !== UNSCOPED) {
      const unscoped = stmts.findPermission.get(
        subjectId, permission,
        UNSCOPED, UNSCOPED,
        UNSCOPED, UNSCOPED,
      );
      if (unscoped && !isExpired(unscoped, now)) return true;
    }
    return false;
  } catch (err) {
    swallow('gate.permission_read_failed', err);
    return false;
  }
}

function isExpired(row, now) {
  return !!row.expires_at && row.expires_at < now;
}

/**
 * Insert or refresh a permission grant. Validates against the zod
 * schema so bogus field shapes are caught at the admin boundary rather
 * than at query time.
 */
export function grantPermission(grant, { now = Date.now } = {}) {
  const ts = now();
  const shaped = {
    subject_id: grant.subjectId,
    permission: grant.permission,
    resource_kind: grant.resourceKind ?? null,
    resource_id: grant.resourceId ?? null,
    granted_at: ts,
    expires_at: grant.expiresAt ?? null,
  };
  const parsed = parseGatePermission(shaped);
  if (!parsed.success) {
    const err = new Error(`invalid permission: ${parsed.error.message}`);
    err.statusCode = 400;
    throw err;
  }
  try {
    const stmts = getGateStatements();
    const scope = normaliseScope(parsed.data.resource_kind, parsed.data.resource_id);
    stmts.grantPermission.run(
      parsed.data.subject_id,
      parsed.data.permission,
      scope.kind,
      scope.id,
      parsed.data.granted_at || ts,
      parsed.data.expires_at ?? null,
    );
    return true;
  } catch (err) {
    swallow('gate.permission_grant_failed', err);
    return false;
  }
}

/**
 * Remove a permission grant. Returns true when a row was deleted.
 */
export function revokePermission({
  subjectId,
  permission,
  resourceKind = null,
  resourceId = null,
}) {
  try {
    if (!subjectId || !permission) return false;
    const stmts = getGateStatements();
    const scope = normaliseScope(resourceKind, resourceId);
    const res = stmts.revokePermission.run(
      subjectId,
      permission,
      scope.kind,
      scope.kind,
      scope.id,
      scope.id,
    );
    return (res?.changes || 0) > 0;
  } catch (err) {
    swallow('gate.permission_revoke_failed', err);
    return false;
  }
}

/**
 * List every grant for a subject. Used by the admin UI and by the
 * /v1/api/gate/permissions/:subject debug endpoint.
 */
export function listPermissions(subjectId) {
  try {
    if (!subjectId) return [];
    const stmts = getGateStatements();
    const rows = stmts.listPermissionsForSubject.all(subjectId);
    return rows.map((row) => {
      const { resource_kind, resource_id } = denormaliseScope(row.resource_kind, row.resource_id);
      return { ...row, resource_kind, resource_id };
    });
  } catch (err) {
    swallow('gate.permission_list_failed', err);
    return [];
  }
}

/**
 * Middleware form: returns a handler shaped `(ctx) => { status, body }
 * | null`. Reads the subject from ctx.auth (populated upstream by
 * auth-middleware.js) and the resource tuple from options.
 */
export function requirePermissionMiddleware(permission, options = {}) {
  return (ctx) => {
    try {
      const subjectId = ctx?.auth?.id || ctx?.actor?.id || ctx?.actor;
      if (!subjectId) {
        return { status: 401, body: { error: 'not_authenticated' } };
      }
      const resourceKind = options.resourceKindFrom
        ? options.resourceKindFrom(ctx)
        : options.resourceKind ?? null;
      const resourceId = options.resourceIdFrom
        ? options.resourceIdFrom(ctx)
        : options.resourceId ?? null;
      if (!hasPermission({ subjectId, permission, resourceKind, resourceId })) {
        return {
          status: 403,
          body: {
            error: 'missing_permission',
            reason_code: 'missing_permission',
            required: permission,
          },
        };
      }
      return null;
    } catch (err) {
      swallow('gate.permission_middleware_failed', err);
      return { status: 500, body: { error: 'permission_check_failed' } };
    }
  };
}
