/**
 * ssot-contracts.test.js — SSOT consolidation contract tests (sweep/gwtasks).
 *
 * S3: parseTaskMetadata — corrupt-row protection proves getNextTask no longer
 *     throws on corrupt metadata rows.
 * S5: response-envelope builders — every ok()/created() body carries
 *     __schema_version; project-routes and phase-routes no longer omit it.
 *
 * These are pure-module tests: no DB, no fs. The only runtime deps are
 * the modules under services/gateway/tasks/ and sdk/ themselves.
 */

import { describe, test, expect } from 'bun:test';
import { parseTaskMetadata } from '../_meta.js';
import { ok, created, badRequest, notFound, forbidden } from '../_internals.js';

// ---------------------------------------------------------------------------
// S3 — parseTaskMetadata contract
// ---------------------------------------------------------------------------

describe('parseTaskMetadata (S3 — metadata-parse canonical home)', () => {
  test('valid JSON object returns the parsed object', () => {
    const result = parseTaskMetadata('{"reviewer_agent":"orion","section":"impl"}');
    expect(result).toEqual({ reviewer_agent: 'orion', section: 'impl' });
  });

  test('null input returns empty object (not corrupt)', () => {
    const result = parseTaskMetadata(null);
    expect(result).toEqual({});
    expect(result._error).toBeUndefined();
  });

  test('undefined input returns empty object (not corrupt)', () => {
    const result = parseTaskMetadata(undefined);
    expect(result).toEqual({});
    expect(result._error).toBeUndefined();
  });

  test('empty string returns empty object (not corrupt)', () => {
    const result = parseTaskMetadata('');
    expect(result).toEqual({});
    expect(result._error).toBeUndefined();
  });

  test('corrupt JSON returns { _error: "metadata_corrupt" }', () => {
    const result = parseTaskMetadata('{not valid json');
    expect(result).toEqual({ _error: 'metadata_corrupt' });
  });

  test('bare null JSON string ("null") returns { _error }', () => {
    const result = parseTaskMetadata('null');
    expect(result._error).toBe('metadata_corrupt');
  });

  test('JSON array returns { _error } (not an object)', () => {
    const result = parseTaskMetadata('[1,2,3]');
    expect(result._error).toBe('metadata_corrupt');
  });

  test('pre-parsed object passes through unchanged', () => {
    const obj = { reviewer_agent: 'orion' };
    expect(parseTaskMetadata(obj)).toBe(obj);
  });

  test('onError callback is called on corrupt input, function still returns sentinel', () => {
    let capturedError = null;
    const result = parseTaskMetadata('{bad json', {
      onError: (err) => { capturedError = err; },
    });
    expect(result._error).toBe('metadata_corrupt');
    expect(capturedError).toBeInstanceOf(Error);
  });

  test('onError callback is NOT called on valid input', () => {
    let called = false;
    const result = parseTaskMetadata('{"ok":true}', {
      onError: () => { called = true; },
    });
    expect(result).toEqual({ ok: true });
    expect(called).toBe(false);
  });

  // LIVE DEFECT (S3 / queries.js:79): prove that a corrupt metadata value
  // never propagates an exception out of the parse path — the prior code
  // had a bare JSON.parse() with no try/catch.
  test('never throws — corrupt row returns sentinel, never propagates an exception', () => {
    const corruptions = [
      '{not json',
      '}{',
      '\x00\x01\x02',
      'undefined',
      'function(){}',
      'SELECT * FROM tasks',
    ];
    for (const bad of corruptions) {
      expect(() => parseTaskMetadata(bad)).not.toThrow();
      expect(parseTaskMetadata(bad)._error).toBe('metadata_corrupt');
    }
  });
});

// ---------------------------------------------------------------------------
// S5 — response-envelope contract
// Each 200/201 builder MUST spread __schema_version.
// ---------------------------------------------------------------------------

describe('response envelope (S5 — ok/created carry __schema_version)', () => {
  test('ok() body carries __schema_version', () => {
    const r = ok({ id: 'abc' });
    expect(r.status).toBe(200);
    expect(typeof r.body.__schema_version).toBe('string');
    expect(r.body.__schema_version.length).toBeGreaterThan(0);
    expect(r.body.id).toBe('abc');
  });

  test('created() body carries __schema_version', () => {
    const r = created({ id: 'def' });
    expect(r.status).toBe(201);
    expect(typeof r.body.__schema_version).toBe('string');
    expect(r.body.__schema_version.length).toBeGreaterThan(0);
    expect(r.body.id).toBe('def');
  });

  test('badRequest() does NOT carry __schema_version (error responses are exempt)', () => {
    const r = badRequest('missing_field');
    expect(r.status).toBe(400);
    expect(r.body.__schema_version).toBeUndefined();
  });

  test('notFound() does NOT carry __schema_version', () => {
    const r = notFound();
    expect(r.status).toBe(404);
    expect(r.body.__schema_version).toBeUndefined();
  });

  test('forbidden() uses reason field (not error field) for the detail string', () => {
    const r = forbidden('admin_only');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
    expect(r.body.reason).toBe('admin_only');
    expect(r.body.__schema_version).toBeUndefined();
  });

  test('ok() __schema_version is stable across calls (same version string)', () => {
    const v1 = ok({}).body.__schema_version;
    const v2 = ok({ x: 1 }).body.__schema_version;
    expect(v1).toBe(v2);
  });

  test('created() __schema_version matches ok() version (same API_SCHEMA_VERSION)', () => {
    expect(ok({}).body.__schema_version).toBe(created({}).body.__schema_version);
  });
});
