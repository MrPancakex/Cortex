/**
 * Behavior tests for /v1/responses proxy support (OpenAI Responses API)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  buildHeaders,
  collectUsageEventsFromSseText,
  extractStreamingUsage,
  extractUsage,
  matchRoute,
} from '../lib/proxy.js';

describe('matchRoute — /v1/responses', () => {
  it('matches the base responses path', () => {
    expect(matchRoute('/v1/responses')).toEqual({
      provider: 'openai',
      targetUrl: 'https://api.openai.com/v1/responses',
      pathAgentId: null,
    });
  });

  it('preserves subpaths such as response lookup/cancel endpoints', () => {
    expect(matchRoute('/v1/responses/resp_123')).toEqual({
      provider: 'openai',
      targetUrl: 'https://api.openai.com/v1/responses/resp_123',
      pathAgentId: null,
    });
    expect(matchRoute('/v1/responses/resp_123/cancel')).toEqual({
      provider: 'openai',
      targetUrl: 'https://api.openai.com/v1/responses/resp_123/cancel',
      pathAgentId: null,
    });
  });

  it('preserves query strings', () => {
    expect(matchRoute('/v1/responses', '?stream=true')).toEqual({
      provider: 'openai',
      targetUrl: 'https://api.openai.com/v1/responses?stream=true',
      pathAgentId: null,
    });
  });

  it('preserves agent prefix tagging while forwarding to the real path', () => {
    expect(matchRoute('/agent/gerald/v1/responses/resp_123', '?include=usage')).toEqual({
      provider: 'openai',
      targetUrl: 'https://api.openai.com/v1/responses/resp_123?include=usage',
      pathAgentId: 'gerald',
    });
  });
});

describe('buildHeaders — openai auth passthrough', () => {
  const originalKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it('forwards caller Authorization header for openai', () => {
    process.env.OPENAI_API_KEY = 'env-key-should-not-win';
    const originalHeaders = new Headers({
      authorization: 'Bearer caller-oauth-token',
      accept: 'application/json',
      'content-type': 'application/json',
      'x-request-id': 'req_123',
    });

    const { headers } = buildHeaders('openai', originalHeaders);

    expect(headers.authorization).toBe('Bearer caller-oauth-token');
    expect(headers.accept).toBe('application/json');
    expect(headers['x-request-id']).toBe('req_123');
  });

  it('falls back to OPENAI_API_KEY only when caller auth is absent', () => {
    process.env.OPENAI_API_KEY = 'env-openai-key';
    const { headers } = buildHeaders('openai', new Headers());
    expect(headers.authorization).toBe('Bearer env-openai-key');
  });

  it('does not treat x-cortex-agent-id as trusted attribution metadata', () => {
    const { headers, projectId } = buildHeaders('openai', new Headers({
      authorization: 'Bearer caller-oauth-token',
      'x-cortex-agent-id': 'atlas',
      'x-cortex-project-id': 'proj_123',
    }));

    expect(headers.authorization).toBe('Bearer caller-oauth-token');
    expect(projectId).toBe('proj_123');
    expect('agentId' in buildHeaders('openai', new Headers({ 'x-cortex-agent-id': 'atlas' }))).toBe(false);
  });
});

describe('extractUsage — Responses API shape', () => {
  it('extracts input_tokens / output_tokens from Responses API body', () => {
    const body = { usage: { input_tokens: 42, output_tokens: 17 } };
    const { tokensIn, tokensOut } = extractUsage('openai', body);
    expect(tokensIn).toBe(42);
    expect(tokensOut).toBe(17);
  });

  it('still handles chat completions usage shape', () => {
    const body = { usage: { prompt_tokens: 10, completion_tokens: 5 } };
    const { tokensIn, tokensOut } = extractUsage('openai', body);
    expect(tokensIn).toBe(10);
    expect(tokensOut).toBe(5);
  });
});

describe('collectUsageEventsFromSseText — Responses API streaming', () => {
  it('extracts response.completed usage events from SSE text', () => {
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":20,"output_tokens":10}}}',
      '',
      '',
    ].join('\n');

    const { usageEvents, remaining } = collectUsageEventsFromSseText(sse);

    expect(remaining).toBe('');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].type).toBe('response.completed');

    const usage = extractStreamingUsage('openai', usageEvents);
    expect(usage).toEqual({ tokensIn: 20, tokensOut: 10 });
  });

  it('keeps trailing partial event data buffered', () => {
    const sse = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"hel',
    ].join('\n');

    const { usageEvents, remaining } = collectUsageEventsFromSseText(sse);
    expect(usageEvents).toEqual([]);
    expect(remaining).toContain('response.output_text.delta');
  });
});
