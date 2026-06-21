import crypto from 'node:crypto';
import { loadIdentity } from './identity.js';
import { constantTimeEqual } from './crypto.js';
import { swallow } from '../errors/index.js';

/**
 * HS256-ish token format: base64url(header).base64url(payload).base64url(sig)
 * where sig = HMAC-SHA256(secret, header + '.' + payload).
 *
 * Kept small on purpose — a full JWT lib would drag a transitive tree into
 * the SDK and we only need symmetric verification today.
 */
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'CJT' })).toString('base64url');

export function signToken(claims, { secret, ttlMs = 3_600_000 } = {}) {
  const key = secret || loadIdentity()?.secret;
  if (!key) throw new Error('no signing secret');
  const payload = { ...claims, iat: Date.now(), exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(`${HEADER}.${body}`).digest('base64url');
  return `${HEADER}.${body}.${sig}`;
}

export async function verifyToken(token, { secret } = {}) {
  const key = secret || loadIdentity()?.secret;
  if (!key) throw new Error('no verifying secret');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const expected = crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url');
  if (!constantTimeEqual(expected, s)) throw new Error('bad signature');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch (err) {
    swallow('auth.verify_parse_failed', err);
    throw new Error('bad payload');
  }
  if (typeof claims.exp !== 'number' || claims.exp < Date.now()) throw new Error('token expired');
  return claims;
}
