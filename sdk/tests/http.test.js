import { describe, test, expect } from 'bun:test';
import { safeJsonParse } from '../http/json-parse.js';
import { validateRequired, validateEnum, validateArray } from '../http/handler-validation.js';
import { toIso, fromIso, normSqliteTs, normIsoTs, normSqliteToIsoZ, nowIso } from '../http/iso.js';

describe('safeJsonParse', () => {
  test('parses valid JSON into { value }', () => {
    const r = safeJsonParse('{"a":1}');
    expect(r.value).toEqual({ a: 1 });
    expect(r.error).toBeUndefined();
  });
  test('returns { error } on invalid JSON', () => {
    const r = safeJsonParse('{not-json');
    expect(r.error).toBeDefined();
    expect(r.value).toBeUndefined();
  });
});

describe('validateRequired', () => {
  test('throws when a required field is missing', () => {
    expect(() => validateRequired({}, ['task_id'])).toThrow(/task_id is required/);
  });
  test('throws on empty string', () => {
    expect(() => validateRequired({ x: '' }, ['x'])).toThrow(/x is required/);
  });
  test('passes when all present', () => {
    expect(() => validateRequired({ a: 1, b: 'x' }, ['a', 'b'])).not.toThrow();
  });
});

describe('validateEnum', () => {
  test('rejects values not in the enum', () => {
    expect(() => validateEnum('status', 'bogus', ['a', 'b'])).toThrow(/status must be one of/);
  });
  test('skips when value is null/undefined', () => {
    expect(() => validateEnum('status', null, ['a'])).not.toThrow();
  });
});

describe('validateArray', () => {
  test('rejects non-array', () => {
    expect(() => validateArray('tags', 'x')).toThrow(/tags must be an array/);
  });
  test('enforces maxLength', () => {
    expect(() => validateArray('tags', [1, 2, 3], { maxLength: 2 })).toThrow(/exceeds maximum length 2/);
  });
});

describe('iso helpers', () => {
  test('toIso handles Date, number, string', () => {
    expect(toIso(new Date('2026-04-22T00:00:00Z'))).toBe('2026-04-22T00:00:00.000Z');
    expect(toIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(toIso('2026-04-22T00:00:00Z')).toBe('2026-04-22T00:00:00.000Z');
    expect(toIso(null)).toBe(null);
    expect(toIso('not-a-date')).toBe(null);
  });
  test('fromIso returns Date or null', () => {
    expect(fromIso('2026-04-22T00:00:00.000Z')).toBeInstanceOf(Date);
    expect(fromIso('not-a-date')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// S1 — contract tests for the canonical timestamp normalisation homes.
// Verifies round-trip between epoch <-> SQLite space-form <-> ISO-T form.
// ---------------------------------------------------------------------------
describe('normSqliteTs (S1 — SQLite space-form canonical home)', () => {
  const EPOCH_MS = 1776816000000; // 2026-04-22T00:00:00.000Z
  const SQLITE   = '2026-04-22 00:00:00';
  const ISO_Z    = '2026-04-22T00:00:00.000Z';
  const ISO_T    = '2026-04-22T00:00:00';

  test('ISO-Z -> SQLite space-form', () => expect(normSqliteTs(ISO_Z)).toBe(SQLITE));
  test('ISO-T -> SQLite space-form', () => expect(normSqliteTs(ISO_T)).toBe(SQLITE));
  test('SQLite space-form is idempotent', () => expect(normSqliteTs(SQLITE)).toBe(SQLITE));
  test('null/undefined -> null', () => {
    expect(normSqliteTs(null)).toBe(null);
    expect(normSqliteTs(undefined)).toBe(null);
  });
  test('garbage string passes through unchanged', () => {
    expect(normSqliteTs('not-a-date')).toBe('not-a-date');
  });
  test('epoch round-trip: toIso(epoch) -> normSqliteTs -> SQLite', () => {
    const isoZ = toIso(EPOCH_MS);
    expect(normSqliteTs(isoZ)).toBe(SQLITE);
  });
  test('strips sub-second precision', () => {
    expect(normSqliteTs('2026-04-22T00:00:00.123Z')).toBe(SQLITE);
  });
});

describe('normIsoTs (S1 — ISO-T form canonical home)', () => {
  const SQLITE = '2026-04-22 00:00:00';
  const ISO_Z  = '2026-04-22T00:00:00.000Z';
  const ISO_T  = '2026-04-22T00:00:00';

  test('SQLite space-form -> ISO-T', () => expect(normIsoTs(SQLITE)).toBe(ISO_T));
  test('ISO-Z -> ISO-T', () => expect(normIsoTs(ISO_Z)).toBe(ISO_T));
  test('ISO-T is idempotent', () => expect(normIsoTs(ISO_T)).toBe(ISO_T));
  test('null/undefined -> null', () => {
    expect(normIsoTs(null)).toBe(null);
    expect(normIsoTs(undefined)).toBe(null);
  });
  test('garbage string passes through unchanged', () => {
    expect(normIsoTs('garbage')).toBe('garbage');
  });
  test('strips sub-second precision', () => {
    expect(normIsoTs('2026-04-22T00:00:00.123Z')).toBe(ISO_T);
  });
});

describe('normSqliteToIsoZ (S1 — ISO-Z second-precision home)', () => {
  test('SQLite space-form -> byte-identical ISO-Z without milliseconds', () => {
    expect(normSqliteToIsoZ('2026-04-22 00:00:00')).toBe('2026-04-22T00:00:00Z');
  });

  test('null/undefined -> null', () => {
    expect(normSqliteToIsoZ(null)).toBe(null);
    expect(normSqliteToIsoZ(undefined)).toBe(null);
  });
});

describe('nowIso (S1 — canonical now)', () => {
  test('returns a full ISO-8601 string with ms precision', () => {
    const ts = nowIso();
    expect(typeof ts).toBe('string');
    // Must include T separator, ms (.nnn), and Z suffix.
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
  test('epoch round-trip: Date.parse(nowIso()) produces a finite number', () => {
    expect(Number.isFinite(Date.parse(nowIso()))).toBe(true);
  });
});
