import { describe, test, expect } from 'bun:test';
import {
  getAgentId,
  mustGetAgentId,
  getAgentPlatform,
  agentContext,
} from '../auth/agent-context.js';

describe('agent-context', () => {
  test('getAgentId reads gateway.config.agentId or null', () => {
    expect(getAgentId({ config: { agentId: 'nova-4' } })).toBe('nova-4');
    expect(getAgentId({ config: {} })).toBe(null);
    expect(getAgentId(null)).toBe(null);
  });

  test('mustGetAgentId throws with statusCode 400 when unset', () => {
    try {
      mustGetAgentId({ config: {} });
      expect(true).toBe(false);
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('agent_id not configured');
    }
  });

  test('getAgentPlatform falls back to agentId', () => {
    expect(getAgentPlatform({ config: { agentId: 'nova-4' } })).toBe('nova-4');
    expect(getAgentPlatform({ config: { agentId: 'nova-4', agentPlatform: 'claude' } })).toBe(
      'claude',
    );
  });

  test('agentContext bundles both fields', () => {
    expect(agentContext({ config: { agentId: 'nova-4' } })).toEqual({
      agentId: 'nova-4',
      platform: 'nova-4',
    });
  });
});
