/**
 * Coverage gaps for sdk/sessions/claim.js:
 *  - sweepOnFailure: lease file removed when writeSync/fsyncSync fails
 *  - cross-user / inaccessible slot is preserved as occupied
 *  - different baseId does not collide
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { claimSessionSlot } from '../../sessions/claim.js';
import { leasePath } from '../../sessions/paths.js';

const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'cortex-claim-gaps-'));

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('claimSessionSlot — different base IDs are independent', () => {
  test('should both claim slot 1 when base IDs differ', () => {
    const a = claimSessionSlot(ROOT, 'nova');
    const b = claimSessionSlot(ROOT, 'orion');
    expect(a.n).toBe(1);
    expect(b.n).toBe(1);
    expect(a.sessionId).toBe('nova');
    expect(b.sessionId).toBe('orion');
  });
});

describe('claimSessionSlot — existing valid lease blocks slot', () => {
  test('should bump to slot 2 when slot 1 has a live pid lease', () => {
    // Write a lease with the current PID (alive) in slot 1
    const slot1 = leasePath(ROOT, 'nova', 1);
    fs.writeFileSync(
      slot1,
      JSON.stringify({ pid: process.pid, session_id: 'nova', base_id: 'nova', v: 1 }),
    );
    const result = claimSessionSlot(ROOT, 'nova');
    expect(result.n).toBe(2);
  });
});

describe('claimSessionSlot — deeply nested runDir', () => {
  test('should create missing directories recursively', () => {
    const nested = path.join(ROOT, 'a', 'b', 'c');
    const result = claimSessionSlot(nested, 'bot');
    expect(result.n).toBe(1);
    expect(result.sessionId).toBe('bot');
    expect(fs.existsSync(leasePath(nested, 'bot', 1))).toBe(true);
  });
});

describe('claimSessionSlot — lease content', () => {
  test('should write pid_start_time field (may be null on non-Linux)', () => {
    const { n } = claimSessionSlot(ROOT, 'nova');
    const raw = fs.readFileSync(leasePath(ROOT, 'nova', n), 'utf8');
    const body = JSON.parse(raw);
    // pid_start_time is null on systems without /proc, a number on Linux
    expect(body).toHaveProperty('pid_start_time');
    expect(body.pid).toBe(process.pid);
  });
});

describe('claimSessionSlot — non-writable runDir triggers EACCES on openSync', () => {
  test('should propagate non-EEXIST error when runDir is not writable', () => {
    if (process.getuid && process.getuid() === 0) return; // root bypasses perms
    const restrictedDir = path.join(ROOT, 'restricted');
    fs.mkdirSync(restrictedDir, { recursive: true });
    fs.chmodSync(restrictedDir, 0o500); // read+execute only, no write
    try {
      let err;
      try {
        claimSessionSlot(restrictedDir, 'nova');
      } catch (e) {
        err = e;
      }
      // Should have thrown with EACCES (non-EEXIST) on openSync, propagating out
      expect(err).toBeDefined();
      expect(err.code).toBe('EACCES');
    } finally {
      fs.chmodSync(restrictedDir, 0o700);
    }
  });
});

describe('claimSessionSlot — mkdirSync failure is swallowed', () => {
  test('should swallow mkdir error when parent is a file (readdirSync then throws)', () => {
    if (process.getuid && process.getuid() === 0) return;
    // Place a regular file where a directory is expected
    const fileBlock = path.join(ROOT, 'blocker');
    fs.writeFileSync(fileBlock, 'not a dir');
    const nestedUnder = path.join(fileBlock, 'sessions');
    // mkdirSync throws ENOTDIR (swallowed at line 41), then readdirSync in
    // getActiveSlots throws ENOTDIR (propagates)
    let err;
    try {
      claimSessionSlot(nestedUnder, 'nova');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
  });
});
