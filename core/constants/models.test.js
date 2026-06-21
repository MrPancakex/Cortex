import { test, expect } from 'bun:test';
import { costFor, resolveModel } from './models.js';

// C0 (token-sweep foundation): the cost table must price the CURRENT (2026)
// model ids actually emitted in usage logs — opus-4-8 / sonnet-4-6 / haiku-4-5 /
// fable-5 — not just the historical -4-7 family. Before this batch, costFor()
// returned null for every one of these (calcCostUsd → null → zeroed cost),
// so each assertion below fails on the pre-fix table (non-vacuous).
const OPUS = { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 };
const SONNET = { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 };
const HAIKU = { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 };

test('C0: current Anthropic model ids are priced', () => {
  expect(costFor('claude-opus-4-8')).toEqual(OPUS);
  expect(costFor('claude-sonnet-4-6')).toEqual(SONNET);
  expect(costFor('claude-haiku-4-5')).toEqual(HAIKU);
});

test('C0: fable-5 is priced (flagged estimate at sonnet tier, not null)', () => {
  expect(costFor('claude-fable-5')).not.toBeNull();
  expect(costFor('claude-fable-5')).toEqual(SONNET);
});

test('C0: date-suffixed haiku id resolves via alias', () => {
  expect(resolveModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  expect(costFor('claude-haiku-4-5-20251001')).toEqual(HAIKU);
});

test('C0: bare aliases point at the current tier ids', () => {
  expect(resolveModel('claude-opus')).toBe('claude-opus-4-8');
  expect(resolveModel('claude-sonnet')).toBe('claude-sonnet-4-6');
  expect(resolveModel('claude-haiku')).toBe('claude-haiku-4-5');
});

test('C0: an unknown model still returns null (guards the non-vacuity boundary)', () => {
  expect(costFor('not-a-real-model-xyz')).toBeNull();
});
