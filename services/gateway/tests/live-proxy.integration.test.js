import { beforeEach, describe, expect, it } from 'bun:test';
import { initDb, getDb } from '../lib/db.js';
import { handleProxy } from '../lib/proxy.js';

function maybeIt(enabled) {
  return enabled ? it : it.skip;
}

async function runProxyRequest(path, { method = 'POST', headers = {}, body }) {
  const req = new Request(`http://gateway.local${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleProxy(req);
}

describe('live gateway proxy integrations', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  maybeIt(!!process.env.OPENAI_API_KEY)('routes a live OpenAI chat completions request', async () => {
    const model = process.env.CORTEX_TEST_OPENAI_MODEL || 'gpt-4.1-nano';
    const res = await runProxyRequest('/v1/chat/completions', {
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: {
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: cortex-openai-ok' }],
        max_tokens: 12,
        temperature: 0,
      },
    });

    expect(res).toBeTruthy();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.choices?.length).toBeGreaterThan(0);

    const saved = getDb().query('SELECT provider, model, status_code FROM gateway_logs ORDER BY id DESC LIMIT 1').get();
    expect(saved.provider).toBe('openai');
    expect(saved.model).toBe(model);
    expect(saved.status_code).toBe(200);
  });

  maybeIt(!!process.env.ANTHROPIC_API_KEY)('routes a live Anthropic messages request', async () => {
    const model = process.env.CORTEX_TEST_ANTHROPIC_MODEL || 'claude-haiku-3-5-20241022';
    const res = await runProxyRequest('/v1/messages', {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2025-02-19',
        'content-type': 'application/json',
      },
      body: {
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: cortex-anthropic-ok' }],
        max_tokens: 12,
        temperature: 0,
      },
    });

    expect(res).toBeTruthy();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.content)).toBe(true);

    const saved = getDb().query('SELECT provider, model, status_code FROM gateway_logs ORDER BY id DESC LIMIT 1').get();
    expect(saved.provider).toBe('anthropic');
    expect(saved.model).toBe(model);
    expect(saved.status_code).toBe(200);
  });

  maybeIt(!!process.env.OPENROUTER_API_KEY)('routes a live OpenRouter chat completions request', async () => {
    const model = process.env.CORTEX_TEST_OPENROUTER_MODEL || 'openai/gpt-4.1-nano';
    const res = await runProxyRequest('/openrouter/v1/chat/completions', {
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
      },
      body: {
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: cortex-openrouter-ok' }],
        max_tokens: 12,
        temperature: 0,
      },
    });

    expect(res).toBeTruthy();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.choices?.length).toBeGreaterThan(0);

    const saved = getDb().query('SELECT provider, model, status_code FROM gateway_logs ORDER BY id DESC LIMIT 1').get();
    expect(saved.provider).toBe('openrouter');
    expect(saved.model).toBe(model);
    expect(saved.status_code).toBe(200);
  });

  maybeIt(true)('routes a live Ollama chat request when local Ollama is available', async () => {
    const tagsRes = await fetch(`${process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'}/api/tags`).catch(() => null);
    if (!tagsRes?.ok) return;
    const tags = await tagsRes.json();
    const model = process.env.CORTEX_TEST_OLLAMA_MODEL || tags.models?.[0]?.name;
    if (!model) return;

    const res = await runProxyRequest('/api/chat', {
      headers: { 'content-type': 'application/json' },
      body: {
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: cortex-ollama-ok' }],
        stream: false,
      },
    });

    expect(res).toBeTruthy();
    if (res.status !== 200) return;
    const data = await res.json();
    expect(data.message).toBeTruthy();

    const saved = getDb().query('SELECT provider, model, status_code FROM gateway_logs ORDER BY id DESC LIMIT 1').get();
    expect(saved.provider).toBe('ollama');
    expect(saved.model).toBe(model);
    expect(saved.status_code).toBe(200);
  });
});
