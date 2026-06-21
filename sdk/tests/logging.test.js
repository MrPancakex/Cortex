import { describe, test, expect } from 'bun:test';
import { createLogger } from '../logging/structured.js';
import { formatStatement } from '../logging/statements.js';

describe('createLogger', () => {
  test('returns every log level as a function', () => {
    const log = createLogger({ level: 'trace' });
    for (const lvl of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      expect(typeof log[lvl]).toBe('function');
    }
  });

  test('.child() merges bindings without mutating parent', () => {
    const parent = createLogger({ level: 'info', bindings: { a: 1 } });
    const child = parent.child({ b: 2 });
    expect(typeof child.info).toBe('function');
  });
});

describe('formatStatement', () => {
  test('normalises whitespace and counts params', () => {
    const f = formatStatement('SELECT  *\n FROM agents WHERE id = ?', ['nova-4']);
    expect(f.sql).toBe('SELECT * FROM agents WHERE id = ?');
    expect(f.param_count).toBe(1);
  });

  test('handles empty params list', () => {
    const f = formatStatement('PRAGMA foreign_keys = ON');
    expect(f.param_count).toBe(0);
  });
});
