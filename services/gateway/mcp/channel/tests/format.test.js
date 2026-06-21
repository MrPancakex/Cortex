import { describe, it, expect } from 'bun:test';
import { formatMessage, buildMeta } from '../format.js';

describe('formatMessage', () => {
  it('returns body when no subject or context', () => {
    expect(formatMessage({ body: 'hello' })).toBe('hello');
  });

  it('prefixes subject line', () => {
    expect(formatMessage({ subject: 'task.assigned', body: 'do the work' })).toBe(
      'Subject: task.assigned\ndo the work',
    );
  });

  it('falls back to content field when body missing', () => {
    expect(formatMessage({ content: 'alt body' })).toBe('alt body');
  });

  it('appends context JSON when non-empty object', () => {
    const result = formatMessage({ body: 'hi', context: { task_id: 'abc' } });
    expect(result).toBe('hi\nContext: {"task_id":"abc"}');
  });

  it('accepts context as a string and parses it', () => {
    const result = formatMessage({ body: 'hi', context: '{"x":1}' });
    expect(result).toBe('hi\nContext: {"x":1}');
  });

  it('silently drops malformed context JSON string', () => {
    const result = formatMessage({ body: 'hi', context: 'not-json' });
    expect(result).toBe('hi');
  });

  it('ignores empty context object', () => {
    const result = formatMessage({ body: 'hi', context: {} });
    expect(result).toBe('hi');
  });
});

describe('buildMeta', () => {
  it('extracts standard fields', () => {
    const msg = {
      from: 'nova',
      message_id: 'msg-1',
      sent_at: '2026-05-29T00:00:00Z',
      message_type: 'directive',
    };
    const meta = buildMeta(msg);
    expect(meta.source).toBe('cortex');
    expect(meta.type).toBe('directive');
    expect(meta.from).toBe('nova');
    expect(meta.message_id).toBe('msg-1');
    expect(meta.ts).toBe('2026-05-29T00:00:00Z');
  });

  it('falls back to created_at when sent_at missing', () => {
    const meta = buildMeta({ created_at: '2026-01-01T00:00:00Z' });
    expect(meta.ts).toBe('2026-01-01T00:00:00Z');
  });

  it('includes optional fields only when present', () => {
    const meta = buildMeta({ task_id: 't1', blocking: true, priority: 'high' });
    expect(meta.task_id).toBe('t1');
    expect(meta.blocking).toBe('true');
    expect(meta.priority).toBe('high');
  });

  it('omits priority when normal', () => {
    const meta = buildMeta({ priority: 'normal' });
    expect(meta.priority).toBeUndefined();
  });

  it('defaults type to text', () => {
    const meta = buildMeta({});
    expect(meta.type).toBe('text');
  });
});
