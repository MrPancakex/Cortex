/**
 * Tests for sdk/logging/recovery.js (recoverLogs)
 * Covers: ENOENT (returns 0), valid jsonl records, corrupt lines (skipped),
 *         mixed valid/corrupt, file deleted after recovery, non-ENOENT read error
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { recoverLogs } from '../../logging/recovery.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-recovery-test-'));
const RECOVERY_FILE = 'log-recovery.jsonl';

function makeLogger() {
  const calls = [];
  const log = { calls };
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    log[level] = (record, msg) => calls.push({ level, record, msg });
  }
  return log;
}

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('recoverLogs', () => {
  test('should return 0 when recovery file does not exist', () => {
    const dir = path.join(ROOT, 'no-file');
    const logger = makeLogger();
    const count = recoverLogs(logger, { root: dir });
    expect(count).toBe(0);
  });

  test('should return 0 for an empty recovery file', () => {
    const dir = path.join(ROOT, 'empty');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, RECOVERY_FILE), '');
    const logger = makeLogger();
    const count = recoverLogs(logger, { root: dir });
    expect(count).toBe(0);
  });

  test('should replay valid records and return correct count', () => {
    const dir = path.join(ROOT, 'valid');
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ level: 'info', msg: 'first record', ts: 1 }),
      JSON.stringify({ level: 'warn', msg: 'second record', ts: 2 }),
    ].join('\n');
    fs.writeFileSync(path.join(dir, RECOVERY_FILE), lines);
    const logger = makeLogger();
    const count = recoverLogs(logger, { root: dir });
    expect(count).toBe(2);
    expect(logger.calls[0].level).toBe('info');
    expect(logger.calls[1].level).toBe('warn');
  });

  test('should delete the recovery file after successful replay', () => {
    const dir = path.join(ROOT, 'delete-after');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, RECOVERY_FILE),
      JSON.stringify({ level: 'info', msg: 'will be deleted' }),
    );
    const logger = makeLogger();
    recoverLogs(logger, { root: dir });
    expect(fs.existsSync(path.join(dir, RECOVERY_FILE))).toBe(false);
  });

  test('should skip corrupt JSON lines and continue', () => {
    const dir = path.join(ROOT, 'corrupt-lines');
    fs.mkdirSync(dir, { recursive: true });
    const content = [
      JSON.stringify({ level: 'info', msg: 'good line 1' }),
      'this is not json {{{ broken',
      JSON.stringify({ level: 'error', msg: 'good line 2' }),
    ].join('\n');
    fs.writeFileSync(path.join(dir, RECOVERY_FILE), content);
    const logger = makeLogger();
    const count = recoverLogs(logger, { root: dir });
    expect(count).toBe(2);
    expect(logger.calls.length).toBe(2);
  });

  test('should skip blank lines', () => {
    const dir = path.join(ROOT, 'blank-lines');
    fs.mkdirSync(dir, { recursive: true });
    const content = [
      JSON.stringify({ level: 'info', msg: 'record' }),
      '',
      '   ',
      JSON.stringify({ level: 'info', msg: 'second' }),
    ].join('\n');
    fs.writeFileSync(path.join(dir, RECOVERY_FILE), content);
    const logger = makeLogger();
    const count = recoverLogs(logger, { root: dir });
    expect(count).toBe(2);
  });

  test('should default to info level when record.level is missing', () => {
    const dir = path.join(ROOT, 'default-level');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, RECOVERY_FILE),
      JSON.stringify({ msg: 'no level field' }),
    );
    const logger = makeLogger();
    recoverLogs(logger, { root: dir });
    expect(logger.calls[0].level).toBe('info');
  });

  test('should handle a file with only whitespace lines returning 0', () => {
    const dir = path.join(ROOT, 'whitespace-only');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, RECOVERY_FILE), '\n\n\n   \n');
    const logger = makeLogger();
    const count = recoverLogs(logger, { root: dir });
    expect(count).toBe(0);
  });

  test('should not throw when recovery file deletion fails (swallowed)', () => {
    // Write a valid record, then make the dir read-only so unlink fails
    const dir = path.join(ROOT, 'unlink-fail');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, RECOVERY_FILE),
      JSON.stringify({ level: 'info', msg: 'test' }),
    );
    // Make directory read-only so unlink fails
    fs.chmodSync(dir, 0o550);
    try {
      const logger = makeLogger();
      // Should not throw
      expect(() => recoverLogs(logger, { root: dir })).not.toThrow();
    } finally {
      // Restore so afterAll cleanup can delete it
      fs.chmodSync(dir, 0o750);
    }
  });
});
