import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { claimSessionSlot } from '../sessions/claim.js';
import {
  releaseSessionSlot,
  releaseSessionSlotIfDead,
} from '../sessions/release.js';
import { leasePath } from '../sessions/paths.js';

const ROOT = path.join(os.tmpdir(), `cortex-sessions-release-test-${process.pid}`);

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('releaseSessionSlot', () => {
  test('owner can release its own slot and the lease file disappears', () => {
    const { n } = claimSessionSlot(ROOT, 'nova');
    const file = leasePath(ROOT, 'nova', n);
    expect(fs.existsSync(file)).toBe(true);

    const result = releaseSessionSlot(ROOT, 'nova', n);
    expect(result.released).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('refuses release when the recorded pid does not match the caller', () => {
    const { n } = claimSessionSlot(ROOT, 'nova');
    // Pick a pid that is well away from our own and unlikely to be a real
    // system process (init is 1, session-leader territory is in the low
    // hundreds — a high fake pid is clearly synthetic for the reader).
    const fakePid = process.pid + 100_000;
    const result = releaseSessionSlot(ROOT, 'nova', n, fakePid);
    expect(result.released).toBe(false);
    expect(result.reason).toBe('pid_mismatch');
    expect(fs.existsSync(leasePath(ROOT, 'nova', n))).toBe(true);
  });

  test('returns not_found when the lease is already gone', () => {
    const result = releaseSessionSlot(ROOT, 'nova', 9);
    expect(result.released).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  test('refuses release on an unparseable lease and preserves the file', () => {
    // Stricter than legacy: we now refuse rather than sweep, so a
    // crashed-writer remnant in a slot claimed by someone else cannot be
    // deleted by a caller acting as "the owner of slot N". Corrupt sweeps
    // are the reaper's job (releaseSessionSlotIfDead).
    const file = path.join(ROOT, 'nova-1.session.json');
    fs.writeFileSync(file, '{ not valid json');
    const result = releaseSessionSlot(ROOT, 'nova', 1);
    expect(result.released).toBe(false);
    expect(result.reason).toBe('corrupt');
    expect(fs.existsSync(file)).toBe(true);
  });

  test('refuses release on an unreadable lease (cross-user EACCES surrogate)', () => {
    if (process.getuid && process.getuid() === 0) return;
    const file = path.join(ROOT, 'nova-1.session.json');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }));
    fs.chmodSync(file, 0o000);
    try {
      const result = releaseSessionSlot(ROOT, 'nova', 1);
      expect(result.released).toBe(false);
      expect(result.reason).toBe('read_failed');
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });
});

describe('releaseSessionSlotIfDead', () => {
  test('refuses when the owner is still alive', () => {
    const { n } = claimSessionSlot(ROOT, 'nova');
    const result = releaseSessionSlotIfDead(ROOT, 'nova', n);
    expect(result.released).toBe(false);
    expect(result.reason).toBe('pid_alive');
    expect(fs.existsSync(leasePath(ROOT, 'nova', n))).toBe(true);
  });

  test('sweeps a lease whose pid is dead', () => {
    const file = path.join(ROOT, 'nova-1.session.json');
    fs.writeFileSync(file, JSON.stringify({ pid: 2_147_483_646, session_id: 'nova' }));
    const result = releaseSessionSlotIfDead(ROOT, 'nova', 1);
    expect(result.released).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('sweeps an unparseable lease as corrupt', () => {
    const file = path.join(ROOT, 'nova-1.session.json');
    fs.writeFileSync(file, '{ not valid json');
    const result = releaseSessionSlotIfDead(ROOT, 'nova', 1);
    expect(result.released).toBe(true);
    expect(result.reason).toBe('corrupt');
    expect(fs.existsSync(file)).toBe(false);
  });

  test('returns not_found when the lease is already gone', () => {
    const result = releaseSessionSlotIfDead(ROOT, 'nova', 9);
    expect(result.released).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  test('defers (read_failed) on an unreadable lease instead of sweeping blind', () => {
    if (process.getuid && process.getuid() === 0) return;
    const file = path.join(ROOT, 'nova-1.session.json');
    fs.writeFileSync(file, JSON.stringify({ pid: 2_147_483_646 }));
    fs.chmodSync(file, 0o000);
    try {
      const result = releaseSessionSlotIfDead(ROOT, 'nova', 1);
      expect(result.released).toBe(false);
      expect(result.reason).toBe('read_failed');
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });
});
