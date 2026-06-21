import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LEASE_POISON_MAX_AGE_MS } from '@cortex/core/constants';
import { isLeasePidAlive, getActiveSlots } from '../sessions/lease.js';

const ROOT = path.join(os.tmpdir(), `cortex-sessions-lease-test-${process.pid}`);

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function writeLease(baseId, n, contents) {
  const file = path.join(ROOT, `${baseId}-${n}.session.json`);
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

describe('isLeasePidAlive', () => {
  test('rejects leases without an integer pid', () => {
    expect(isLeasePidAlive(null)).toBe(false);
    expect(isLeasePidAlive({})).toBe(false);
    expect(isLeasePidAlive({ pid: 'x' })).toBe(false);
  });

  test('accepts a lease whose pid is the current process (no start-time token)', () => {
    expect(isLeasePidAlive({ pid: process.pid })).toBe(true);
  });

  test('rejects a lease for a pid that is definitely dead', () => {
    expect(isLeasePidAlive({ pid: 2_147_483_646 })).toBe(false);
  });

  test('rejects a lease whose recorded start-time mismatches /proc (recycled pid)', () => {
    if (process.platform !== 'linux') return;
    expect(isLeasePidAlive({ pid: process.pid, pid_start_time: 'definitely-wrong' })).toBe(false);
  });
});

describe('getActiveSlots', () => {
  test('returns an empty list for an unused base id', () => {
    expect(getActiveSlots(ROOT, 'nobody')).toEqual([]);
  });

  test('surfaces a live-pid lease with its recorded session_id', () => {
    writeLease('nova', 1, { pid: process.pid, session_id: 'nova' });
    const slots = getActiveSlots(ROOT, 'nova');
    expect(slots).toHaveLength(1);
    expect(slots[0].n).toBe(1);
    expect(slots[0].pid).toBe(process.pid);
    expect(slots[0].sessionId).toBe('nova');
  });

  test('sweeps a dead-pid lease instead of surfacing it', () => {
    const file = writeLease('nova', 1, { pid: 2_147_483_646, session_id: 'nova' });
    expect(getActiveSlots(ROOT, 'nova')).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('preserves an unreadable lease (ioError) as occupied with pid:0', () => {
    const file = writeLease('nova', 1, { pid: process.pid });
    // chmod 0 so our own read fails with EACCES (the cross-user case in
    // miniature). Gate on effective-uid 0 — root bypasses the mode check.
    if (process.getuid && process.getuid() === 0) return;
    fs.chmodSync(file, 0o000);
    try {
      const slots = getActiveSlots(ROOT, 'nova');
      expect(slots).toHaveLength(1);
      expect(slots[0].pid).toBe(0);
      expect(slots[0].sessionId).toBe('nova');
      // Lease must be preserved, not swept.
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  test('young unparseable lease is treated as occupied, not swept', () => {
    const file = writeLease('nova', 1, '{ not valid json');
    const slots = getActiveSlots(ROOT, 'nova');
    expect(slots).toHaveLength(1);
    expect(slots[0].pid).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('old unparseable lease is swept as crashed-writer debris', () => {
    const file = writeLease('nova', 1, '{ not valid json');
    // Backdate mtime safely past LEASE_POISON_MAX_AGE_MS, whatever it is
    // set to — the test tracks the code's actual threshold.
    const past = new Date(Date.now() - LEASE_POISON_MAX_AGE_MS * 2 - 1_000);
    fs.utimesSync(file, past, past);
    const slots = getActiveSlots(ROOT, 'nova');
    expect(slots).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('young unparseable lease just under the threshold is preserved', () => {
    const file = writeLease('nova', 1, '{ not valid json');
    // Pin mtime to "now" so slow CI can't let the file age past the
    // threshold between write and scan.
    const now = Date.now() / 1000;
    fs.utimesSync(file, now, now);
    const slots = getActiveSlots(ROOT, 'nova');
    expect(slots).toHaveLength(1);
    expect(slots[0].pid).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('results are sorted by slot number ascending', () => {
    writeLease('nova', 3, { pid: process.pid });
    writeLease('nova', 1, { pid: process.pid });
    writeLease('nova', 2, { pid: process.pid });
    const slots = getActiveSlots(ROOT, 'nova');
    expect(slots.map((s) => s.n)).toEqual([1, 2, 3]);
  });

  test('ignores files that do not match the base-id prefix or suffix', () => {
    writeLease('nova', 1, { pid: process.pid });
    fs.writeFileSync(path.join(ROOT, 'orion-1.session.json'), JSON.stringify({ pid: process.pid }));
    fs.writeFileSync(path.join(ROOT, 'nova-1.other.json'), '{}');
    const slots = getActiveSlots(ROOT, 'nova');
    expect(slots).toHaveLength(1);
    expect(slots[0].n).toBe(1);
  });
});
