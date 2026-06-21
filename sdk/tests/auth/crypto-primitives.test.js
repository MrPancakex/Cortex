import { describe, expect, test } from 'bun:test';
import { deriveBearer, sha256Hex } from '../../auth/crypto.js';

describe('auth crypto primitives', () => {
  test('sha256Hex returns lowercase hex', () => {
    expect(sha256Hex('nova-token')).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256Hex('nova-token')).toBe(sha256Hex('nova-token'));
  });

  test('deriveBearer hashes raw tokens once', () => {
    expect(deriveBearer('nova-token')).toBe(sha256Hex('nova-token'));
  });

  test('deriveBearer preserves already-derived 64-hex tokens', () => {
    const derived = sha256Hex('nova-token');
    expect(deriveBearer(derived)).toBe(derived);
    expect(deriveBearer(derived.toUpperCase())).toBe(derived);
  });

  test('deriveBearer trims input', () => {
    expect(deriveBearer('  nova-token  ')).toBe(sha256Hex('nova-token'));
  });
});
