import fs from 'node:fs';
import path from 'node:path';
import { signToken } from './verify.js';
import { resolveStateRoot } from '@cortex/core/constants';

const ADMIN_FILE = 'admin.token';

export async function generateToken({ kind = 'agent', sub, ttlMs, root }) {
  if (!sub) throw new Error('generateToken: sub required');
  const token = signToken({ kind, sub }, { ttlMs });
  if (kind === 'admin') {
    const p = path.join(resolveStateRoot(root), ADMIN_FILE);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, token, { mode: 0o600 });
  }
  return token;
}
