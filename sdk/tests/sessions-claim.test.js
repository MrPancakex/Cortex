import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { claimSessionSlot } from '../sessions/claim.js';
import { leasePath } from '../sessions/paths.js';

const ROOT = path.join(os.tmpdir(), `cortex-sessions-claim-test-${process.pid}`);

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('claimSessionSlot', () => {
  test('first claim lands on slot 1 with bare base id', () => {
    const result = claimSessionSlot(ROOT, 'nova');
    expect(result.n).toBe(1);
    expect(result.sessionId).toBe('nova');
  });

  test('subsequent concurrent claims step through slots 2, 3, ...', () => {
    const one = claimSessionSlot(ROOT, 'nova');
    const two = claimSessionSlot(ROOT, 'nova');
    const three = claimSessionSlot(ROOT, 'nova');
    expect([one.n, two.n, three.n]).toEqual([1, 2, 3]);
    expect([one.sessionId, two.sessionId, three.sessionId]).toEqual(['nova', 'nova-2', 'nova-3']);
  });

  test('skips stale leases whose pid is dead', () => {
    const stale = leasePath(ROOT, 'nova', 1);
    fs.writeFileSync(
      stale,
      JSON.stringify({ pid: 2_147_483_646, session_id: 'nova' }),
    );
    const result = claimSessionSlot(ROOT, 'nova');
    // The dead-pid file is swept by getActiveSlots → new claim takes slot 1.
    expect(result.n).toBe(1);
    expect(fs.existsSync(stale)).toBe(true); // new lease now lives there
  });

  test('persists pid + session_id + iso timestamp in the lease file', () => {
    const { n } = claimSessionSlot(ROOT, 'orion');
    const file = leasePath(ROOT, 'orion', n);
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(body.base_id).toBe('orion');
    expect(body.session_id).toBe('orion');
    expect(body.pid).toBe(process.pid);
    expect(typeof body.claimed_at).toBe('string');
    expect(Number.isNaN(Date.parse(body.claimed_at))).toBe(false);
  });

  test('lands on mode 0o640 (owner rw, group r) to defeat umask', () => {
    if (process.getuid && process.getuid() === 0) return;
    const { n } = claimSessionSlot(ROOT, 'nova');
    const file = leasePath(ROOT, 'nova', n);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o640);
  });

  test('creates the runDir if it does not exist', () => {
    const nested = path.join(ROOT, 'nested', 'deep');
    const { n } = claimSessionSlot(nested, 'nova');
    expect(n).toBe(1);
    expect(fs.existsSync(leasePath(nested, 'nova', 1))).toBe(true);
  });
});
