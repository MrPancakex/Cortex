import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { swallow } from '../errors/index.js';
import { resolveStateRoot } from '@cortex/core/constants';

const FILE = 'identity.json';

function identityPath(root) {
  return path.join(resolveStateRoot(root), FILE);
}

export function loadIdentity({ root } = {}) {
  try {
    const raw = fs.readFileSync(identityPath(root), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') swallow('auth.load_identity_failed', err);
    return null;
  }
}

export function saveIdentity(identity, { root } = {}) {
  const p = identityPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function rotateIdentity({ root } = {}) {
  const next = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    secret: crypto.randomBytes(32).toString('base64url'),
  };
  saveIdentity(next, { root });
  return next;
}
