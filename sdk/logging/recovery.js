import fs from 'node:fs';
import path from 'node:path';
import { swallow } from '../errors/index.js';
import { resolveLogRoot } from '@cortex/core/constants';

/**
 * Drain an on-disk recovery log. When structured logging fails (e.g. stdout
 * is closed during shutdown) we fall through to a jsonl file; the next boot
 * rereads it and republishes the records.
 */
const RECOVERY_FILE = 'log-recovery.jsonl';

export function recoverLogs(logger, { root } = {}) {
  const p = path.join(resolveLogRoot(root), RECOVERY_FILE);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') swallow('log.recovery_read_failed', err);
    return 0;
  }

  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      logger[record.level || 'info'](record, record.msg);
      count += 1;
    } catch (err) {
      swallow('log.recovery_parse_failed', err);
    }
  }
  try {
    fs.unlinkSync(p);
  } catch (err) {
    swallow('log.recovery_unlink_failed', err);
  }
  return count;
}
