import { verifyToken } from './verify.js';
import { findAgent } from './registry.js';
import { isAdmin } from './admin.js';
import { swallow } from '../errors/index.js';
import { unauthorized, forbidden } from '../http/index.js';

/**
 * Generic bearer-token middleware. Attaches `req.auth` = { kind, id, token }.
 * Downstream handlers decide whether agent or admin is sufficient.
 */
export async function authMiddleware(req, res, next) {
  const header = req.headers?.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return unauthorized(res, 'missing bearer token');
  let claims;
  try {
    claims = await verifyToken(token);
  } catch (err) {
    swallow('auth.middleware_verify_failed', err);
    return unauthorized(res, 'invalid token');
  }
  req.auth = { kind: claims.kind, id: claims.sub, token, claims };
  return next();
}

export function requireAdmin(req, res, next) {
  if (!req.auth || !isAdmin(req.auth)) return forbidden(res, 'admin required');
  return next();
}

export function requireAgent(req, res, next) {
  if (!req.auth || req.auth.kind !== 'agent') return forbidden(res, 'agent required');
  const agent = findAgent(req.auth.id);
  if (!agent || agent.status === 'disabled') return forbidden(res, 'agent disabled');
  req.agent = agent;
  return next();
}
