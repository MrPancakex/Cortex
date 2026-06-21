import { describe, test, expect } from 'bun:test';
import { BridgeSendSchema } from '../schemas/bridge.js';

describe('BridgeSendSchema — target_session', () => {
  test('parses a message with target_session present', () => {
    const result = BridgeSendSchema.safeParse({
      kind: 'message',
      to: 'nova',
      content: 'x',
      target_session: 'nova-2',
    });
    expect(result.success).toBe(true);
    expect(result.data.target_session).toBe('nova-2');
  });

  test('parses a message WITHOUT target_session (field is optional)', () => {
    const result = BridgeSendSchema.safeParse({
      kind: 'message',
      to: 'nova',
      content: 'x',
    });
    expect(result.success).toBe(true);
    expect(result.data.target_session).toBeUndefined();
  });

  test('rejects an empty-string target_session (min(1) guard)', () => {
    const result = BridgeSendSchema.safeParse({
      kind: 'message',
      to: 'nova',
      content: 'x',
      target_session: '',
    });
    expect(result.success).toBe(false);
  });

  test('parses a message with sender_session present', () => {
    const result = BridgeSendSchema.safeParse({
      kind: 'message',
      to: 'nova',
      content: 'x',
      sender_session: 'nova-2',
    });
    expect(result.success).toBe(true);
    expect(result.data.sender_session).toBe('nova-2');
  });

  test('rejects an empty-string sender_session (min(1) guard)', () => {
    const result = BridgeSendSchema.safeParse({
      kind: 'message',
      to: 'nova',
      content: 'x',
      sender_session: '',
    });
    expect(result.success).toBe(false);
  });
});
