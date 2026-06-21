import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { formatSessionId, resolveSessionId } from '../sessions/id.js';

const ROOT = path.join(os.tmpdir(), `cortex-sessions-id-test-${process.pid}`);

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function writeLease(baseId, n, body) {
  const file = path.join(ROOT, `${baseId}-${n}.session.json`);
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

describe('formatSessionId', () => {
  test('slot 1 keeps the bare base id', () => {
    expect(formatSessionId('nova', 1)).toBe('nova');
  });

  test('slot >= 2 appends -N', () => {
    expect(formatSessionId('nova', 2)).toBe('nova-2');
    expect(formatSessionId('orion', 7)).toBe('orion-7');
  });

  test('rejects an empty baseId', () => {
    expect(() => formatSessionId('', 1)).toThrow(/non-empty string/);
  });

  test('rejects a non-string baseId', () => {
    expect(() => formatSessionId(42, 1)).toThrow(/non-empty string/);
  });

  test('rejects a non-positive slot number', () => {
    expect(() => formatSessionId('nova', 0)).toThrow(/positive integer/);
    expect(() => formatSessionId('nova', -1)).toThrow(/positive integer/);
    expect(() => formatSessionId('nova', 1.5)).toThrow(/positive integer/);
  });
});

describe('resolveSessionId', () => {
  test('returns the bare baseId with found=false for an invalid pid', () => {
    expect(resolveSessionId(ROOT, 'nova', 0)).toEqual({
      sessionId: 'nova', n: null, found: false,
    });
    expect(resolveSessionId(ROOT, 'nova', -1)).toEqual({
      sessionId: 'nova', n: null, found: false,
    });
    expect(resolveSessionId(ROOT, 'nova', Number.NaN)).toEqual({
      sessionId: 'nova', n: null, found: false,
    });
  });

  test('returns the bare baseId with found=false when runDir cannot be read', () => {
    const result = resolveSessionId(path.join(ROOT, 'does-not-exist'), 'nova', process.pid);
    expect(result).toEqual({ sessionId: 'nova', n: null, found: false });
  });

  test('returns the bare baseId with found=false when no lease matches', () => {
    writeLease('nova', 1, { pid: process.pid + 100_000, session_id: 'nova' });
    expect(resolveSessionId(ROOT, 'nova', process.pid)).toEqual({
      sessionId: 'nova', n: null, found: false,
    });
  });

  test('returns the matching lease session_id when pid matches', () => {
    writeLease('nova', 2, { pid: process.pid, session_id: 'nova-2' });
    expect(resolveSessionId(ROOT, 'nova', process.pid)).toEqual({
      sessionId: 'nova-2', n: 2, found: true,
    });
  });

  test('falls back to formatSessionId when the lease has no session_id', () => {
    writeLease('nova', 3, { pid: process.pid });
    expect(resolveSessionId(ROOT, 'nova', process.pid)).toEqual({
      sessionId: 'nova-3', n: 3, found: true,
    });
  });

  test('skips unparseable leases and keeps looking for a match', () => {
    writeLease('nova', 1, '{ not valid json');
    writeLease('nova', 2, { pid: process.pid, session_id: 'nova-2' });
    expect(resolveSessionId(ROOT, 'nova', process.pid)).toEqual({
      sessionId: 'nova-2', n: 2, found: true,
    });
  });

  test('ignores files that do not match the baseId prefix or suffix', () => {
    writeLease('orion', 1, { pid: process.pid, session_id: 'orion' });
    fs.writeFileSync(path.join(ROOT, 'nova-1.other.json'), JSON.stringify({ pid: process.pid }));
    expect(resolveSessionId(ROOT, 'nova', process.pid)).toEqual({
      sessionId: 'nova', n: null, found: false,
    });
  });
});
