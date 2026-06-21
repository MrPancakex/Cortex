import { describe, test, expect } from 'bun:test';
import { hashSecret, constantTimeEqual } from '../auth/crypto.js';
import { isAdmin, adminIdentity } from '../auth/admin.js';
import { signToken, verifyToken } from '../auth/verify.js';

describe('crypto helpers', () => {
  test('hashSecret produces salt + hash strings', () => {
    const h = hashSecret('password');
    expect(typeof h.salt).toBe('string');
    expect(typeof h.hash).toBe('string');
    expect(h.hash.length).toBeGreaterThan(40);
  });
  test('hashSecret with explicit salt is deterministic', () => {
    const salt = Buffer.from('0123456789abcdef');
    const a = hashSecret('p', { salt });
    const b = hashSecret('p', { salt });
    expect(a.hash).toBe(b.hash);
  });
  test('constantTimeEqual true for matching strings', () => {
    expect(constantTimeEqual('abcd', 'abcd')).toBe(true);
  });
  test('constantTimeEqual false for mismatched length', () => {
    expect(constantTimeEqual('a', 'ab')).toBe(false);
  });
  test('constantTimeEqual false for mismatched content', () => {
    expect(constantTimeEqual('abcd', 'abce')).toBe(false);
  });
});

describe('admin identity', () => {
  test('isAdmin only for kind=admin', () => {
    expect(isAdmin({ kind: 'admin', sub: 'root' })).toBe(true);
    expect(isAdmin({ kind: 'agent', sub: 'nova' })).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
  test('adminIdentity returns the canonical shape', () => {
    expect(adminIdentity()).toEqual({ kind: 'admin', sub: 'root' });
  });
});

describe('signToken / verifyToken', () => {
  const SECRET = 'phase-2-test-secret';
  test('signed token round-trips through verify', async () => {
    const token = signToken({ kind: 'agent', sub: 'nova-4' }, { secret: SECRET });
    const claims = await verifyToken(token, { secret: SECRET });
    expect(claims.kind).toBe('agent');
    expect(claims.sub).toBe('nova-4');
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.exp).toBe('number');
  });
  test('tampered signature rejected', async () => {
    const token = signToken({ kind: 'agent', sub: 'x' }, { secret: SECRET });
    const [h, p] = token.split('.');
    const bad = `${h}.${p}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    await expect(verifyToken(bad, { secret: SECRET })).rejects.toThrow(/bad signature/);
  });
  test('expired token rejected', async () => {
    const token = signToken({ kind: 'agent', sub: 'x' }, { secret: SECRET, ttlMs: -1 });
    await expect(verifyToken(token, { secret: SECRET })).rejects.toThrow(/expired/);
  });
});
