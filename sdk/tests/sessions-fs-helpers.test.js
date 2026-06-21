import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readLeaseFile,
  getLeaseAgeMs,
  sweepLease,
} from '../sessions/fs-helpers.js';

const ROOT = path.join(os.tmpdir(), `cortex-sessions-fs-helpers-test-${process.pid}`);

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('readLeaseFile', () => {
  test('returns { value } on a valid JSON lease', () => {
    const file = path.join(ROOT, 'valid.json');
    fs.writeFileSync(file, JSON.stringify({ pid: 42 }));
    const result = readLeaseFile(file);
    expect(result.value).toEqual({ pid: 42 });
    expect(result.ioError).toBeUndefined();
    expect(result.syntaxError).toBeUndefined();
  });

  test('returns { syntaxError } when content is unparseable JSON', () => {
    const file = path.join(ROOT, 'bad.json');
    fs.writeFileSync(file, '{ broken');
    const result = readLeaseFile(file);
    expect(result.syntaxError).toBeDefined();
    expect(result.value).toBeUndefined();
    expect(result.ioError).toBeUndefined();
  });

  test('returns { ioError } with ENOENT when the file is missing', () => {
    const result = readLeaseFile(path.join(ROOT, 'absent.json'));
    expect(result.ioError).toBeDefined();
    expect(result.ioError.code).toBe('ENOENT');
    expect(result.value).toBeUndefined();
    expect(result.syntaxError).toBeUndefined();
  });

  test('returns { ioError } with EACCES when the file is unreadable', () => {
    if (process.getuid && process.getuid() === 0) return;
    const file = path.join(ROOT, 'unreadable.json');
    fs.writeFileSync(file, JSON.stringify({ pid: 42 }));
    fs.chmodSync(file, 0o000);
    try {
      const result = readLeaseFile(file);
      expect(result.ioError).toBeDefined();
      expect(result.ioError.code).toBe('EACCES');
      expect(result.value).toBeUndefined();
      expect(result.syntaxError).toBeUndefined();
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  test('the three fields are mutually exclusive — ioError branch', () => {
    const r = readLeaseFile(path.join(ROOT, 'missing.json'));
    expect(Object.keys(r).filter((k) => r[k] !== undefined)).toEqual(['ioError']);
  });

  test('the three fields are mutually exclusive — value branch', () => {
    const file = path.join(ROOT, 'ok.json');
    fs.writeFileSync(file, JSON.stringify({ pid: 7 }));
    const r = readLeaseFile(file);
    expect(Object.keys(r).filter((k) => r[k] !== undefined)).toEqual(['value']);
  });

  test('the three fields are mutually exclusive — syntaxError branch', () => {
    const file = path.join(ROOT, 'corrupt.json');
    fs.writeFileSync(file, '{ broken');
    const r = readLeaseFile(file);
    expect(Object.keys(r).filter((k) => r[k] !== undefined)).toEqual(['syntaxError']);
  });
});

describe('getLeaseAgeMs', () => {
  test('returns a finite number for an existing file', () => {
    const file = path.join(ROOT, 'present.json');
    fs.writeFileSync(file, '{}');
    const age = getLeaseAgeMs(file);
    // age is Date.now() - mtimeMs. On filesystems with sub-ms mtime
    // precision (ext4's nanosecond-resolution mtimeMs paired with
    // integer-ms Date.now()) the value can be a small negative near the
    // write; the contract is "probe that returns a number", not "always
    // >= 0". We verify shape + magnitude bound to catch gross errors
    // without depending on kernel clock alignment.
    expect(typeof age).toBe('number');
    expect(Number.isFinite(age)).toBe(true);
    expect(Math.abs(age)).toBeLessThan(60_000);
  });

  test('returns null when stat fails (missing file)', () => {
    expect(getLeaseAgeMs(path.join(ROOT, 'absent.json'))).toBeNull();
  });

  test('reflects backdated mtime when utimesSync is applied', () => {
    const file = path.join(ROOT, 'old.json');
    fs.writeFileSync(file, '{}');
    const pastSec = (Date.now() - 120_000) / 1000;
    fs.utimesSync(file, pastSec, pastSec);
    const age = getLeaseAgeMs(file);
    expect(age).toBeGreaterThan(100_000);
  });
});

describe('sweepLease', () => {
  test('returns true after removing an existing file', () => {
    const file = path.join(ROOT, 'doomed.json');
    fs.writeFileSync(file, '{}');
    expect(sweepLease(file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('returns true on a missing file (rm force:true is silent on ENOENT)', () => {
    expect(sweepLease(path.join(ROOT, 'ghost.json'))).toBe(true);
  });
});
