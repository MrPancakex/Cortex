import fs from 'node:fs';
import path from 'node:path';
import { swallow } from '../errors/index.js';
import { resolveStateRoot } from '@cortex/core/constants';

export function loadToken(filename, { root } = {}) {
  try {
    return fs.readFileSync(path.join(resolveStateRoot(root), filename), 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') swallow('auth.load_token_failed', err);
    return null;
  }
}
