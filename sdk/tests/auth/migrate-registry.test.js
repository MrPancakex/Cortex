/**
 * Tests for sdk/auth/migrate-registry.js — the shared merge logic
 * between bin/cortex-init.js's --repair mode and any future migration
 * caller.
 *
 * The single invariant that matters for not regressing a working
 * install: **canonical wins on key conflict.** A legacy file may
 * carry stale entries from a botched seed; the merge must never
 * overwrite an entry that already exists at the canonical path.
 */

import { test, describe, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateLegacyRegistry } from '../../auth/migrate-registry.js';

let tempRoot;
let legacyPath;
let canonicalPath;
let saved;
let saveCanonical;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-migrate-test-'));
  legacyPath = path.join(tempRoot, 'legacy.json');
  canonicalPath = path.join(tempRoot, 'state', 'canonical.json');
  saved = null;
  // Stand-in for init.js's atomic saveReg — captures what would have
  // been written so tests can assert on it without an fs round-trip.
  saveCanonical = (reg) => {
    saved = reg;
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, JSON.stringify(reg) + '\n');
  };
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('migrateLegacyRegistry', () => {
  test('no-op when legacy file does not exist', () => {
    const r = migrateLegacyRegistry({ legacyPath, canonicalPath, saveCanonical });
    expect(r.skipped).toBe('legacy_absent');
    expect(saved).toBeNull();
    expect(fs.existsSync(canonicalPath)).toBe(false);
  });

  test('no-op when legacy file is zero bytes', () => {
    fs.writeFileSync(legacyPath, '');
    const r = migrateLegacyRegistry({ legacyPath, canonicalPath, saveCanonical });
    expect(r.skipped).toBe('legacy_empty');
    expect(saved).toBeNull();
  });

  test('reports unparseable on malformed JSON without crashing', () => {
    fs.writeFileSync(legacyPath, '{ not valid json');
    const r = migrateLegacyRegistry({ legacyPath, canonicalPath, saveCanonical });
    expect(r.skipped).toBe('legacy_unparseable');
    expect(r.unparseable).toBe(true);
    expect(saved).toBeNull();
  });

  test('no-op when legacy is shaped wrong (missing agents key)', () => {
    fs.writeFileSync(legacyPath, JSON.stringify({ random: 'object' }));
    const r = migrateLegacyRegistry({ legacyPath, canonicalPath, saveCanonical });
    expect(r.skipped).toBe('legacy_malformed');
    expect(saved).toBeNull();
  });

  test('no-op when legacyPath === canonicalPath', () => {
    const samePath = path.join(tempRoot, 'same.json');
    fs.writeFileSync(samePath, JSON.stringify({ agents: { nova: { hash: 'x' } } }));
    const r = migrateLegacyRegistry({
      legacyPath: samePath, canonicalPath: samePath, saveCanonical,
    });
    expect(r.skipped).toBe('same_path_or_missing');
    expect(saved).toBeNull();
  });

  test('canonical absent + legacy populated → all legacy entries land in canonical', () => {
    fs.writeFileSync(legacyPath, JSON.stringify({
      agents: {
        nova:  { hash: 'a'.repeat(64), role: 'agent' },
        orion: { hash: 'b'.repeat(64), role: 'agent' },
        root:  { hash: 'c'.repeat(64), role: 'admin' },
      },
    }));
    const r = migrateLegacyRegistry({ legacyPath, canonicalPath, saveCanonical });
    expect(r.merged).toBe(3);
    expect(r.conflicts).toBe(0);
    expect(saved.agents.nova.hash).toBe('a'.repeat(64));
    expect(saved.agents.orion.hash).toBe('b'.repeat(64));
    expect(saved.agents.root.role).toBe('admin');
  });

  // The load-bearing invariant: a re-init or accidental merge against
  // a working canonical must NEVER overwrite an existing agent entry.
  test('canonical wins on key conflict (legacy entry is dropped)', () => {
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, JSON.stringify({
      agents: { nova: { hash: 'CANONICAL-WINS'.padEnd(64, '0'), role: 'agent' } },
    }));
    fs.writeFileSync(legacyPath, JSON.stringify({
      agents: { nova: { hash: 'legacy-stale'.padEnd(64, '0'), role: 'agent' } },
    }));
    const r = migrateLegacyRegistry({ legacyPath, canonicalPath, saveCanonical });
    expect(r.merged).toBe(0);
    expect(r.conflicts).toBe(1);
    // saveCanonical not invoked because nothing changed.
    expect(saved).toBeNull();
    const onDisk = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
    expect(onDisk.agents.nova.hash.startsWith('CANONICAL-WINS')).toBe(true);
  });

  test('canonical populated + legacy with new key → new key merged, existing untouched', () => {
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, JSON.stringify({
      agents: { nova: { hash: 'a'.repeat(64), role: 'agent' } },
    }));
    fs.writeFileSync(legacyPath, JSON.stringify({
      agents: {
        nova:  { hash: 'STALE'.padEnd(64, '0'), role: 'agent' },  // conflict, dropped
        orion: { hash: 'z'.repeat(64), role: 'agent' },           // new, merged
        scout: { hash: 'f'.repeat(64), role: 'agent' },           // new, merged
      },
    }));
    const r = migrateLegacyRegistry({ legacyPath, canonicalPath, saveCanonical });
    expect(r.merged).toBe(2);
    expect(r.conflicts).toBe(1);
    expect(saved.agents.nova.hash).toBe('a'.repeat(64));    // canonical preserved
    expect(saved.agents.orion.hash).toBe('z'.repeat(64));  // legacy merged
    expect(saved.agents.scout.hash).toBe('f'.repeat(64));
  });
});
