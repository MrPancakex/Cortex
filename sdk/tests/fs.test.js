import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ensureDir,
  readJson,
  writeFileAtomic,
  writeJsonAtomic,
  appendJsonLine,
  safeRename,
  safeUnlink,
} from '../fs/helpers.js';

const ROOT = path.join(os.tmpdir(), `cortex-fs-test-${process.pid}`);

function withPatchedFs(overrides, fn) {
  const originals = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    originals.set(key, fs[key]);
    fs[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of originals.entries()) {
      fs[key] = value;
    }
  }
}

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('fs helpers', () => {
  test('ensureDir creates nested dirs', () => {
    const d = path.join(ROOT, 'a/b/c');
    ensureDir(d);
    expect(fs.existsSync(d)).toBe(true);
  });

  test('readJson returns fallback for missing file', () => {
    const r = readJson(path.join(ROOT, 'missing.json'), { default: true });
    expect(r).toEqual({ default: true });
  });

  test('writeJsonAtomic then readJson round-trips', () => {
    const f = path.join(ROOT, 'x.json');
    writeJsonAtomic(f, { hello: 'world' });
    expect(readJson(f)).toEqual({ hello: 'world' });
  });

  test('writeJsonAtomic uses unique temp paths and avoids fixed .tmp', () => {
    const target = '/virtual/state.json';
    const tmpPaths = [];

    withPatchedFs({
      mkdirSync: () => {},
      writeFileSync: (file) => {
        tmpPaths.push(file);
      },
      renameSync: (from, to) => {
        expect(to).toBe(target);
        expect(from).not.toBe(`${target}.tmp`);
      },
    }, () => {
      writeJsonAtomic(target, { seq: 1 });
      writeJsonAtomic(target, { seq: 2 });
    });

    expect(tmpPaths).toHaveLength(2);
    expect(tmpPaths[0]).toMatch(/^\/virtual\/state\.json\./);
    expect(tmpPaths[0]).toMatch(/\.tmp$/);
    expect(tmpPaths[1]).toMatch(/^\/virtual\/state\.json\./);
    expect(tmpPaths[1]).toMatch(/\.tmp$/);
    expect(tmpPaths[0]).not.toBe(tmpPaths[1]);
  });

  test('writeFileAtomic writes plain text without JSON stringifying it', () => {
    const target = path.join(ROOT, 'plain', 'note.md');
    writeFileAtomic(target, '# Title\n\nbody\n', { mode: 0o660, dirMode: 0o770 });
    expect(fs.readFileSync(target, 'utf8')).toBe('# Title\n\nbody\n');
  });

  test('writeJsonAtomic cleans up temp file when rename fails', () => {
    const target = '/virtual/rename-fails.json';
    const err = new Error('rename failed');
    const unlinked = [];
    let tmpPath = null;

    withPatchedFs({
      mkdirSync: () => {},
      writeFileSync: (file) => {
        tmpPath = file;
      },
      renameSync: () => {
        throw err;
      },
      unlinkSync: (file) => {
        unlinked.push(file);
      },
    }, () => {
      expect(() => writeJsonAtomic(target, { ok: false })).toThrow(err);
    });

    expect(unlinked).toEqual([tmpPath]);
  });

  test('writeJsonAtomic cleans up temp file when write fails', () => {
    const target = '/virtual/write-fails.json';
    const err = new Error('write failed');
    const unlinked = [];
    let tmpPath = null;

    withPatchedFs({
      mkdirSync: () => {},
      writeFileSync: (file) => {
        tmpPath = file;
        throw err;
      },
      renameSync: () => {
        throw new Error('rename should not run');
      },
      unlinkSync: (file) => {
        unlinked.push(file);
      },
    }, () => {
      expect(() => writeJsonAtomic(target, { ok: false })).toThrow(err);
    });

    expect(unlinked).toEqual([tmpPath]);
  });

  test('appendJsonLine appends one JSON object per line', () => {
    const f = path.join(ROOT, 'y.jsonl');
    appendJsonLine(f, { a: 1 });
    appendJsonLine(f, { b: 2 });
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ a: 1 });
  });

  test('safeRename returns true on success, false on missing', () => {
    const a = path.join(ROOT, 'rename-a');
    const b = path.join(ROOT, 'rename-b');
    fs.writeFileSync(a, 'hello');
    expect(safeRename(a, b)).toBe(true);
    expect(safeRename(a, b)).toBe(false);
  });

  test('safeUnlink returns true on success, false (silent) on ENOENT', () => {
    const f = path.join(ROOT, 'to-delete');
    fs.writeFileSync(f, 'x');
    expect(safeUnlink(f)).toBe(true);
    expect(safeUnlink(f)).toBe(false);
  });
});
