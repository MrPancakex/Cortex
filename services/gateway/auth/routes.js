/**
 * HTTP routes for the scope-grant admin endpoints.
 *
 * All three endpoints are Unix-socket-only (ctx.isAdminSocket must be true).
 * Trying via TCP → 403 admin_scope_requires_unix_socket.
 *
 * Routes:
 *   POST   /v1/api/auth/grant_scope
 *   POST   /v1/api/auth/revoke_grant
 *   GET    /v1/api/auth/grants
 */

import { createGrant, revokeGrant, listGrants } from './grants.js';
import { auditGrant } from './audit.js';

function ok(body, status = 200) {
  return { status, body };
}

function err(code, reason, status = 400) {
  return { status, body: { error: code, reason } };
}

function requireUnixSocket(ctx) {
  if (!ctx?.isAdminSocket) {
    return err('admin_scope_requires_unix_socket', 'use ~/.cortex/admin.sock', 403);
  }
  return null;
}

function grantScopeHandler(ctx) {
  const guard = requireUnixSocket(ctx);
  if (guard) return guard;

  const body = ctx?.body;
  if (!body || typeof body !== 'object') return err('invalid_body', 'body must be an object');

  const { agent, target_scope, ttl_seconds, justification } = body;
  if (!agent) return err('invalid_params', 'agent is required');
  if (!target_scope) return err('invalid_params', 'target_scope is required');
  if (ttl_seconds === undefined || ttl_seconds === null) return err('invalid_params', 'ttl_seconds is required');

  const granted_by = ctx?.actor?.id || ctx?.actor?.base || 'operator';
  const result = createGrant({ agent, target_scope, ttl_seconds, granted_by, justification: justification || '' });
  if (!result.ok) {
    const status = result.error === 'ttl_too_long' ? 400 : 400;
    return { status, body: { error: result.error } };
  }

  auditGrant('auth.scope_granted', {
    grant_id: result.grant_id,
    agent,
    target_scope,
    ttl_seconds,
    granted_by,
    justification: justification || '',
  });

  return ok({ grant_id: result.grant_id, expires_at: result.expires_at, revocation_token: result.revocation_token });
}

function revokeGrantHandler(ctx) {
  const guard = requireUnixSocket(ctx);
  if (guard) return guard;

  const body = ctx?.body;
  if (!body || typeof body !== 'object') return err('invalid_body', 'body must be an object');

  const { grant_id, revocation_token } = body;
  if (!grant_id) return err('invalid_params', 'grant_id is required');
  if (!revocation_token) return err('invalid_params', 'revocation_token is required');

  const result = revokeGrant(grant_id, revocation_token);
  if (!result.ok) {
    const status = result.error === 'grant_not_found' ? 404 : 400;
    return { status, body: { error: result.error } };
  }

  auditGrant('auth.scope_revoked', { grant_id, agent: result.agent });
  return ok({ ok: true, agent: result.agent });
}

function listGrantsHandler(ctx) {
  const guard = requireUnixSocket(ctx);
  if (guard) return guard;

  return ok({ grants: listGrants() });
}

/**
 * Mount the three scope-grant admin endpoints.
 * Named `mountGrantRoutes` to distinguish from check.js's `mountAuthRoutes`.
 *
 * @param {{ add: (method: string, path: string, handler: Function) => void }} adapter
 */
export function mountGrantRoutes(adapter) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('mountGrantRoutes: adapter must expose add(method, path, handler)');
  }
  adapter.add('POST', '/v1/api/auth/grant_scope', grantScopeHandler);
  adapter.add('POST', '/v1/api/auth/revoke_grant', revokeGrantHandler);
  adapter.add('GET', '/v1/api/auth/grants', listGrantsHandler);
}
