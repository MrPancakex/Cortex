import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createStatements } from '../db/statements-factory.js';

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.run(`CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)`);
});

afterAll(() => {
  try { db?.close(); } catch { /* already closed */ }
});

describe('createStatements', () => {
  test('returns a frozen map from spec name to prepared Statement', () => {
    const stmts = createStatements(db, [
      { name: 'insert', sql: 'INSERT INTO kv (k, v) VALUES (?, ?)' },
      { name: 'get', sql: 'SELECT v FROM kv WHERE k = ?' },
    ]);

    expect(Object.isFrozen(stmts)).toBe(true);
    expect(typeof stmts.insert.run).toBe('function');
    expect(typeof stmts.get.get).toBe('function');

    stmts.insert.run('a', 'alpha');
    expect(stmts.get.get('a')).toEqual({ v: 'alpha' });
  });

  test('rejects a db handle that does not expose prepare()', () => {
    expect(() => createStatements({}, [])).toThrow(/prepare\(\) method/);
    expect(() => createStatements(null, [])).toThrow(/prepare\(\) method/);
  });

  test('rejects specs that are not arrays', () => {
    expect(() => createStatements(db, null)).toThrow(/array/);
    expect(() => createStatements(db, 'nope')).toThrow(/array/);
  });

  test('rejects spec entries missing name or sql', () => {
    expect(() => createStatements(db, [{ sql: 'SELECT 1' }])).toThrow(/non-empty string/);
    expect(() => createStatements(db, [{ name: 'x' }])).toThrow(/non-empty string/);
    expect(() => createStatements(db, [{ name: '', sql: 'SELECT 1' }])).toThrow(/non-empty string/);
    expect(() => createStatements(db, [{ name: 'x', sql: '' }])).toThrow(/non-empty string/);
  });

  test('rejects duplicate statement names', () => {
    expect(() => createStatements(db, [
      { name: 'dup', sql: 'SELECT 1' },
      { name: 'dup', sql: 'SELECT 2' },
    ])).toThrow(/duplicate statement name "dup"/);
  });

  test('rejects whitespace-only SQL so typos surface with a clear message', () => {
    expect(() => createStatements(db, [{ name: 'x', sql: '   \n\t ' }]))
      .toThrow(/non-empty string/);
  });

  test('rejects specs with unknown keys (typo catch)', () => {
    expect(() => createStatements(db, [
      { name: 'x', sqll: 'SELECT 1', sql: 'SELECT 2' },
    ])).toThrow(/unknown key "sqll"/);
  });

  test('rejects reserved names that would shadow builtins', () => {
    for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
      expect(() => createStatements(db, [{ name, sql: 'SELECT 1' }]))
        .toThrow(/reserved \(would shadow builtin\)/);
    }
  });

  test('the returned map uses a null prototype so builtin names are absent', () => {
    const stmts = createStatements(db, [{ name: 'q', sql: 'SELECT 1' }]);
    // Object.getPrototypeOf returns null for Object.create(null) maps.
    expect(Object.getPrototypeOf(stmts)).toBeNull();
    // Accessing a builtin method name returns undefined, not a function.
    expect(stmts.toString).toBeUndefined();
    expect(stmts.hasOwnProperty).toBeUndefined();
  });

  test('the returned map cannot be mutated', () => {
    const stmts = createStatements(db, [{ name: 'get', sql: 'SELECT 1' }]);
    expect(() => { stmts.get = null; }).toThrow();
    expect(() => { stmts.added = {}; }).toThrow();
  });

  test('returns an empty frozen object for an empty spec list', () => {
    const stmts = createStatements(db, []);
    expect(Object.keys(stmts)).toEqual([]);
    expect(Object.isFrozen(stmts)).toBe(true);
  });
});
