import { describe, expect, test } from 'bun:test';
import { peelSlotSuffix, tokenFileNames, vaultCandidates } from '../../auth/slot.js';

describe('auth slot helpers', () => {
  test('peels one trailing numeric slot suffix only', () => {
    expect(peelSlotSuffix('nova')).toBe('nova');
    expect(peelSlotSuffix('nova-2')).toBe('nova');
    expect(peelSlotSuffix('codex-worker-3')).toBe('codex-worker');
    expect(peelSlotSuffix('nova-2-2')).toBe('nova-2');
  });

  test('does not peel non-numeric hyphen suffixes', () => {
    expect(peelSlotSuffix('nova-v2')).toBe('nova-v2');
    expect(peelSlotSuffix('nova-2fa')).toBe('nova-2fa');
  });

  test('vault candidates are exact-id-first, then peeled base', () => {
    expect(tokenFileNames('nova-7')).toEqual(['nova-7', 'nova']);
    expect(vaultCandidates('/keys', 'nova-7')).toEqual([
      '/keys/nova-7.env',
      '/keys/nova.env',
    ]);
  });
});
