import { loadIdentity, rotateIdentity } from './identity.js';
import { generateToken } from './generate-token.js';
import { swallow } from '../errors/index.js';

/**
 * One-shot bootstrap. Used by `cortex init` and the first gateway boot to
 * ensure an identity + admin token exists. Idempotent.
 */
export async function initAuth({ root, force = false } = {}) {
  let identity = loadIdentity({ root });
  if (!identity || force) identity = rotateIdentity({ root });

  let adminToken = null;
  try {
    adminToken = await generateToken({ kind: 'admin', sub: 'root', root });
  } catch (err) {
    swallow('auth.init_generate_failed', err);
  }

  return { identity, adminToken };
}
