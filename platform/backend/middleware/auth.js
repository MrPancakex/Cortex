/**
 * Platform backend auth — loopback-only + bearer/cookie fallback.
 *
 * The v0.1 dashboard backend injected an admin token into every forwarded
 * request. That was only safe because the backend's listener was pinned to
 * loopback; the middleware here preserves that invariant and layers the SDK's
 * canonical bearer/cookie auth on top for any non-loopback deployments that
 * may come later.
 *
 *   1. `assertLoopbackBinding(host)` — thrown at boot if the host isn't a
 *      loopback address. A `localhost` DNS binding is treated as loopback.
 *   2. `requireLoopback(req, res, next)` — 403s any request whose remote
 *      address isn't 127.0.0.1 / ::1.
 *   3. `platformAuth(req, res, next)` — delegates to sdk/auth's
 *      `authMiddleware` when an Authorization header is present; otherwise
 *      reads the `cortex_session` cookie so the browser UI can stay signed
 *      in without shipping bearer headers on every fetch.
 */
import { authMiddleware as sdkAuth, verifyToken } from '@cortex/sdk/auth';
import { swallow } from '@cortex/sdk/errors';
import { unauthorized, forbidden } from '@cortex/sdk/http';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const COOKIE_NAME = 'cortex_session';

export function assertLoopbackBinding(host) {
  if (host === 'localhost') return; // DNS-level loopback
  if (!LOOPBACK.has(host)) {
    throw new Error(`platform backend must bind to loopback; got: ${host}`);
  }
}

export function requireLoopback(req, res, next) {
  const remote = (req && (req.ip || req.socket?.remoteAddress)) || '';
  if (!LOOPBACK.has(remote)) {
    return forbidden(res, 'backend is loopback-only');
  }
  return next();
}

export function parseCookie(raw) {
  const out = {};
  if (!raw) return out;
  for (const part of String(raw).split(';')) {
    const [k, ...rest] = part.split('=');
    if (!k) continue;
    const key = k.trim();
    if (!key) continue;
    const value = rest.join('=').trim();
    try {
      out[key] = decodeURIComponent(value || '');
    } catch (err) {
      swallow('platform.cookie_decode_failed', err);
      out[key] = value;
    }
  }
  return out;
}

export async function platformAuth(req, res, next) {
  if (req.headers?.authorization) {
    return sdkAuth(req, res, next);
  }
  const cookies = parseCookie(req.headers?.cookie || '');
  const token = cookies[COOKIE_NAME];
  if (!token) return unauthorized(res, 'missing session');
  let claims;
  try {
    claims = await verifyToken(token);
  } catch (err) {
    swallow('platform.auth_cookie_failed', err);
    return unauthorized(res, 'invalid session');
  }
  req.auth = { kind: claims.kind, id: claims.sub, token, claims };
  return next();
}
