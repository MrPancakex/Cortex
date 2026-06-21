import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  bufferEnvelope,
  drainRecoveryBuffer,
  recoveryFilePath,
} from '../events/recovery.js';

const ROOT = path.join(os.tmpdir(), `cortex-events-recovery-${process.pid}`);
const RECOVERY_FILE = path.join(ROOT, 'event-recovery.jsonl');

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.CORTEX_EVENT_RECOVERY_FILE = RECOVERY_FILE;
});

afterAll(() => {
  delete process.env.CORTEX_EVENT_RECOVERY_FILE;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('recoveryFilePath', () => {
  test('honors CORTEX_EVENT_RECOVERY_FILE override', () => {
    expect(recoveryFilePath()).toBe(RECOVERY_FILE);
  });
});

describe('bufferEnvelope', () => {
  test('appends one JSON line per call', () => {
    bufferEnvelope({ id: 'a', subject: 'x.y' });
    bufferEnvelope({ id: 'b', subject: 'x.y' });
    const raw = fs.readFileSync(RECOVERY_FILE, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe('a');
    expect(JSON.parse(lines[1]).id).toBe('b');
  });
});

describe('drainRecoveryBuffer', () => {
  test('calls replay for each line and deletes the file on full drain', async () => {
    bufferEnvelope({ id: 'a' });
    bufferEnvelope({ id: 'b' });
    const ids = [];
    const result = await drainRecoveryBuffer(async (env) => {
      ids.push(env.id);
      return true;
    });
    expect(result).toEqual({ drained: 2, kept: 0 });
    expect(ids.sort()).toEqual(['a', 'b']);
    expect(fs.existsSync(RECOVERY_FILE)).toBe(false);
  });

  test('keeps entries whose replay returns false', async () => {
    bufferEnvelope({ id: 'keep' });
    bufferEnvelope({ id: 'drop' });
    const result = await drainRecoveryBuffer(async (env) => env.id === 'drop');
    expect(result).toEqual({ drained: 1, kept: 1 });
    const raw = fs.readFileSync(RECOVERY_FILE, 'utf8');
    expect(raw).toContain('"keep"');
    expect(raw).not.toContain('"drop"');
  });

  test('returns drained:0 when the buffer does not exist', async () => {
    const result = await drainRecoveryBuffer(async () => true);
    expect(result).toEqual({ drained: 0, kept: 0 });
  });

  test('skips unparseable lines without failing the whole drain', async () => {
    fs.writeFileSync(RECOVERY_FILE, '{ not valid\n{"id":"a"}\n');
    const ids = [];
    const result = await drainRecoveryBuffer(async (env) => {
      ids.push(env.id);
      return true;
    });
    expect(result.drained).toBe(1);
    expect(ids).toEqual(['a']);
  });
});
