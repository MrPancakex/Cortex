import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { swallow } from '../errors/index.js';

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') swallow('fs.read_json_failed', err);
    return fallback;
  }
}

function cleanupTmp(tmp) {
  try {
    fs.unlinkSync(tmp);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    try {
      swallow('fs.atomic_write_cleanup_failed', err);
    } catch {
      // Preserve the original write/rename failure when CORTEX_THROW is set.
    }
  }
}

export function writeFileAtomic(
  file,
  content,
  {
    mode = 0o600,
    dirMode = 0o700,
  } = {},
) {
  ensureDir(path.dirname(file), dirMode);
  const suffix = `${process.pid}.${Date.now()}.${randomUUID()}`;
  const tmp = `${file}.${suffix}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.renameSync(tmp, file);
    renamed = true;
  } finally {
    if (!renamed) cleanupTmp(tmp);
  }
}

export function writeJsonAtomic(
  file,
  value,
  {
    mode = 0o600,
    dirMode = 0o700,
    trailingNewline = false,
  } = {},
) {
  const json = JSON.stringify(value, null, 2);
  writeFileAtomic(file, trailingNewline ? `${json}\n` : json, { mode, dirMode });
}

export const atomicWriteJson = writeJsonAtomic;

export function appendJsonLine(file, value, { mode = 0o600 } = {}) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode });
}

export function safeRename(from, to) {
  try {
    fs.renameSync(from, to);
    return true;
  } catch (err) {
    swallow('fs.rename_failed', err);
    return false;
  }
}

export function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') swallow('fs.unlink_failed', err);
    return false;
  }
}
