import { describe, test, expect, beforeEach } from 'bun:test';
import { swallow, getCounters, resetCounters } from '../errors/swallow.js';

beforeEach(() => {
  resetCounters();
});

describe('swallow', () => {
  test('increments the named counter on each call', () => {
    swallow('test.metric_a', new Error('boom'));
    swallow('test.metric_a', new Error('boom2'));
    swallow('test.metric_b', new Error('b'));
    const c = getCounters();
    expect(c['test.metric_a']).toBe(2);
    expect(c['test.metric_b']).toBe(1);
  });

  test('tolerates a missing err argument', () => {
    swallow('test.no_err');
    expect(getCounters()['test.no_err']).toBe(1);
  });

  test('exposes last error messages', () => {
    swallow('test.last', new Error('bang'));
    expect(getCounters().__lastErrors['test.last']).toBe('bang');
  });
});
