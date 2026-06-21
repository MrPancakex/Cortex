/**
 * HTTP route mounting for the gate plane. Takes an adapter object
 * shaped `{ add(method, path, handler) }` — same adapter shape the
 * bridge, tasks, and sessions planes use. Each handler returns the
 * standard `{ status, body }` envelope the gateway's Bun Server wrapper
 * translates into an HTTP response.
 *
 * Routes mounted:
 *   GET    /v1/api/gate/policies
 *   GET    /v1/api/gate/policies/:id
 *   PUT    /v1/api/gate/policies/:id
 *   DELETE /v1/api/gate/policies/:id
 *   POST   /v1/api/gate/reload
 *   POST   /v1/api/gate/evaluate       — in-process evaluate (debug)
 *   GET    /v1/api/gate/permissions/:subject
 *   POST   /v1/api/gate/permissions
 *   DELETE /v1/api/gate/permissions
 *
 * Admin writes emit gate.policy_written so the audit trail flows through
 * the event bus rather than a separate audit_log.
 */

import { swallow } from '@cortex/sdk/errors';
import { parseGatePolicy } from '../../../core/schemas/gate.js';
import {
  refreshPolicies,
  listPolicies,
  getPolicyById,
  upsertPolicy,
  removePolicy,
  policyCacheVersion,
  policyCacheSize,
} from './policies.js';
import { evaluate } from './evaluator.js';
import {
  grantPermission,
  revokePermission,
  listPermissions,
} from './permissions.js';
import {
  emitGatePolicyWritten,
  emitGateLoaded,
} from './events.js';

function ok(body, status = 200) {
  return { status, body };
}

function err(code, reason, status = 400, extras = {}) {
  return { status, body: { error: code, reason, ...extras } };
}

// -- handlers --------------------------------------------------------------

function listPoliciesHandler() {
  return ok({
    version: policyCacheVersion(),
    count: policyCacheSize(),
    policies: listPolicies(),
  });
}

function getPolicyHandler(ctx) {
  const id = ctx?.params?.id;
  if (!id) return err('invalid_params', 'id is required');
  const policy = getPolicyById(id);
  if (!policy) return err('not_found', 'policy does not exist', 404);
  return ok({ policy });
}

function putPolicyHandler(ctx) {
  const id = ctx?.params?.id;
  if (!id) return err('invalid_params', 'id is required');
  const body = ctx?.body;
  if (!body || typeof body !== 'object') return err('invalid_body', 'body must be an object');
  const parsed = parseGatePolicy({ ...body, id });
  if (!parsed.success) {
    return err('invalid_policy', parsed.error.message, 400, {
      details: parsed.error.flatten(),
    });
  }
  try {
    const policy = upsertPolicy(parsed.data);
    try {
      emitGatePolicyWritten({
        policyId: policy.id,
        op: 'upsert',
        actor: ctx?.actor?.id || ctx?.actor || undefined,
      });
    } catch (emitErr) {
      swallow('gate.policy_written_emit_failed', emitErr);
    }
    return ok({ ok: true, policy });
  } catch (persistErr) {
    if (persistErr?.statusCode === 400) {
      return err('invalid_policy', persistErr.message, 400);
    }
    swallow('gate.policy_upsert_failed', persistErr);
    return err('persist_failed', persistErr?.message || 'db error', 500);
  }
}

function deletePolicyHandler(ctx) {
  const id = ctx?.params?.id;
  if (!id) return err('invalid_params', 'id is required');
  try {
    const removed = removePolicy(id);
    if (!removed) return err('not_found', 'policy does not exist', 404);
    try {
      emitGatePolicyWritten({
        policyId: id,
        op: 'delete',
        actor: ctx?.actor?.id || ctx?.actor || undefined,
      });
    } catch (emitErr) {
      swallow('gate.policy_deleted_emit_failed', emitErr);
    }
    return ok({ ok: true });
  } catch (persistErr) {
    swallow('gate.policy_delete_failed', persistErr);
    return err('persist_failed', persistErr?.message || 'db error', 500);
  }
}

function reloadHandler() {
  try {
    const version = refreshPolicies();
    try {
      emitGateLoaded({
        policyCount: policyCacheSize(),
        version,
      });
    } catch (emitErr) {
      swallow('gate.loaded_emit_failed', emitErr);
    }
    return ok({ ok: true, version, count: policyCacheSize() });
  } catch (reloadErr) {
    swallow('gate.reload_failed', reloadErr);
    return err('reload_failed', reloadErr?.message || 'reload error', 500);
  }
}

function evaluateDebugHandler(ctx) {
  const body = ctx?.body;
  if (!body || typeof body !== 'object') return err('invalid_body', 'body must be an object');
  if (!body.subject || typeof body.subject !== 'object') {
    return err('invalid_body', 'subject is required');
  }
  if (typeof body.action !== 'string' || !body.action) {
    return err('invalid_body', 'action is required');
  }
  try {
    const decision = evaluate({
      direction: body.direction,
      subject: body.subject,
      action: body.action,
      resource: body.resource,
    });
    return ok({ decision });
  } catch (evalErr) {
    swallow('gate.evaluate_debug_failed', evalErr);
    return err('evaluate_failed', evalErr?.message || 'evaluator error', 500);
  }
}

function listPermissionsHandler(ctx) {
  const subject = ctx?.params?.subject;
  if (!subject) return err('invalid_params', 'subject is required');
  return ok({ permissions: listPermissions(subject) });
}

function grantPermissionHandler(ctx) {
  const body = ctx?.body;
  if (!body || typeof body !== 'object') return err('invalid_body', 'body must be an object');
  try {
    const success = grantPermission({
      subjectId: body.subject_id,
      permission: body.permission,
      resourceKind: body.resource_kind ?? null,
      resourceId: body.resource_id ?? null,
      expiresAt: body.expires_at ?? null,
    });
    if (!success) return err('persist_failed', 'could not persist grant', 500);
    return ok({ ok: true });
  } catch (grantErr) {
    if (grantErr?.statusCode === 400) {
      return err('invalid_grant', grantErr.message, 400);
    }
    swallow('gate.permission_grant_handler_failed', grantErr);
    return err('persist_failed', grantErr?.message || 'db error', 500);
  }
}

function revokePermissionHandler(ctx) {
  const body = ctx?.body;
  if (!body || typeof body !== 'object') return err('invalid_body', 'body must be an object');
  try {
    const removed = revokePermission({
      subjectId: body.subject_id,
      permission: body.permission,
      resourceKind: body.resource_kind ?? null,
      resourceId: body.resource_id ?? null,
    });
    return ok({ ok: true, removed });
  } catch (revokeErr) {
    swallow('gate.permission_revoke_handler_failed', revokeErr);
    return err('persist_failed', revokeErr?.message || 'db error', 500);
  }
}

/**
 * @param {{ add: (method: string, path: string, handler: Function) => void }} adapter
 */
export function mountGateRoutes(adapter) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('mountGateRoutes: adapter must expose add(method, path, handler)');
  }
  adapter.add('GET', '/v1/api/gate/policies', listPoliciesHandler);
  adapter.add('GET', '/v1/api/gate/policies/:id', getPolicyHandler);
  adapter.add('PUT', '/v1/api/gate/policies/:id', putPolicyHandler);
  adapter.add('DELETE', '/v1/api/gate/policies/:id', deletePolicyHandler);
  adapter.add('POST', '/v1/api/gate/reload', reloadHandler);
  adapter.add('POST', '/v1/api/gate/evaluate', evaluateDebugHandler);
  adapter.add('GET', '/v1/api/gate/permissions/:subject', listPermissionsHandler);
  adapter.add('POST', '/v1/api/gate/permissions', grantPermissionHandler);
  adapter.add('DELETE', '/v1/api/gate/permissions', revokePermissionHandler);
}
