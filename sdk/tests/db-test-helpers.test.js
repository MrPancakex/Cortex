import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb } from '../db/connection.js';
import { resetDbForTests } from '../db/test-helpers.js';

const ROOT = path.join(os.tmpdir(), `cortex-db-test-helpers-${process.pid}`);

beforeEach(() => {
  resetDbForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  resetDbForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('resetDbForTests', () => {
  test('next getDb() after reset returns a fresh connection', () => {
    const first = getDb({ path: path.join(ROOT, 'a.db') });
    // Prove the first handle works before the reset.
    first.run(`CREATE TABLE t (x INT)`);

    resetDbForTests();

    const second = getDb({ path: path.join(ROOT, 'b.db') });
    // A different override path is honored because the singleton was cleared.
    expect(second).not.toBe(first);
    // The fresh db does not carry the schema from the old one.
    const row = second.query(`SELECT name FROM sqlite_master WHERE name = 't'`).get();
    expect(row).toBeNull();
  });

  test('is idempotent — calling it with no open db does not throw', () => {
    resetDbForTests();
    expect(() => resetDbForTests()).not.toThrow();
  });
});
