import { describe, test, expect } from 'bun:test';
import { validatePayload, validateEnvelope } from '../events/validate.js';

describe('validatePayload', () => {
  test('accepts a valid task.claimed payload', () => {
    const r = validatePayload('task.claimed', {
      task_id: '11111111-2222-4333-8444-555555555555',
      assigned_agent: 'nova-4',
      claimed_at: 0,
    });
    expect(r.ok).toBe(true);
  });

  test('returns unknown_subject for a subject not in the taxonomy', () => {
    const r = validatePayload('made.up', {});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown_subject');
  });

  test('returns payload_invalid with zod issues when fields are wrong', () => {
    const r = validatePayload('task.claimed', {
      task_id: 'not-a-uuid',
      assigned_agent: 'nova-4',
      claimed_at: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('payload_invalid');
    expect(Array.isArray(r.issues)).toBe(true);
    expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe('validateEnvelope', () => {
  test('accepts a well-formed envelope', () => {
    const r = validateEnvelope({
      id: '11111111-2222-4333-8444-555555555555',
      subject: 'task.claimed',
      ts: 1,
      source: 'cortex',
      payload: {},
      v: 1,
    });
    expect(r.ok).toBe(true);
  });
  test('rejects a broken envelope with an issues array', () => {
    const r = validateEnvelope({ subject: 'task.claimed' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('envelope_invalid');
  });
});
