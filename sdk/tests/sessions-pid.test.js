import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { readPidStartTime, isPidAlive } from '../sessions/pid.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.CORTEX_FORCE_NO_PROC;
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('readPidStartTime', () => {
  test('returns null when CORTEX_FORCE_NO_PROC is set', () => {
    process.env.CORTEX_FORCE_NO_PROC = '1';
    expect(readPidStartTime(process.pid)).toBeNull();
  });

  test('returns null for non-integer or non-positive pids', () => {
    expect(readPidStartTime(0)).toBeNull();
    expect(readPidStartTime(-1)).toBeNull();
    expect(readPidStartTime(Number.NaN)).toBeNull();
    expect(readPidStartTime(1.5)).toBeNull();
  });

  test('returns null for a definitely-dead pid', () => {
    // 2^31 - 2 is beyond typical pid_max on all supported kernels.
    expect(readPidStartTime(2_147_483_646)).toBeNull();
  });

  test('returns a non-empty opaque token for our own pid on Linux', () => {
    if (process.platform !== 'linux' || !existsSync('/proc/self/stat')) return;
    const token = readPidStartTime(process.pid);
    expect(token).not.toBeNull();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });
});

describe('isPidAlive', () => {
  test('rejects non-integer or non-positive pids', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
  });

  test('is true for our own running process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test('is false for a pid that is certainly gone', () => {
    expect(isPidAlive(2_147_483_646)).toBe(false);
  });

  test('treats EPERM (cross-user pid) as alive — not dead', () => {
    const original = process.kill;
    process.kill = () => {
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    };
    try {
      expect(isPidAlive(12345)).toBe(true);
    } finally {
      process.kill = original;
    }
  });

  test('treats ESRCH as dead', () => {
    const original = process.kill;
    process.kill = () => {
      const err = new Error('no such process');
      err.code = 'ESRCH';
      throw err;
    };
    try {
      expect(isPidAlive(12345)).toBe(false);
    } finally {
      process.kill = original;
    }
  });
});
