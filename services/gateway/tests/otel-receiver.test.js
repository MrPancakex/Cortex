import { beforeEach, describe, expect, it } from 'bun:test';
import { getDb, getStmts, initDb } from '../lib/db.js';
import { extractOtelEvents, ingestOtelPayload } from '../lib/otel.js';

describe('OTLP receiver', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  it('maps OTLP JSON log records into otel_events rows', () => {
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'codex.thread_id', value: { stringValue: 'thread_123' } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1742600000000000000',
                  severityText: 'INFO',
                  body: { stringValue: 'codex.turn.tool.call' },
                  attributes: [
                    { key: 'codex.run_id', value: { stringValue: 'run_abc' } },
                    { key: 'codex.model', value: { stringValue: 'gpt-4.1' } },
                    { key: 'codex.auth_mode', value: { stringValue: 'chatgpt-oauth' } },
                    { key: 'codex.input_tokens', value: { intValue: '120' } },
                    { key: 'codex.output_tokens', value: { intValue: '45' } },
                    { key: 'codex.latency_ms', value: { intValue: '980' } },
                    { key: 'codex.request_status', value: { stringValue: 'ok' } },
                    { key: 'codex.tool_name', value: { stringValue: 'exec_command' } },
                    { key: 'codex.tool_success', value: { boolValue: true } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const rows = ingestOtelPayload(getStmts(), payload, { sourceAgent: 'zeus', provider: 'openai' });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_agent: 'zeus',
      provider: 'openai',
      run_id: 'run_abc',
      thread_id: 'thread_123',
      model: 'gpt-4.1',
      auth_mode: 'chatgpt-oauth',
      tokens_in: 120,
      tokens_out: 45,
      latency_ms: 980,
      status: 'ok',
      tool_name: 'exec_command',
      tool_success: 1,
      event_type: 'codex.turn.tool.call',
    });
    expect(rows[0].cost_usd).toBeCloseTo((120 * 2.0 + 45 * 8.0) / 1_000_000, 10);

    const saved = getDb().query('SELECT * FROM otel_events ORDER BY id DESC LIMIT 1').get();
    expect(saved.run_id).toBe('run_abc');
    expect(saved.thread_id).toBe('thread_123');
    expect(saved.model).toBe('gpt-4.1');
    expect(saved.tokens_in).toBe(120);
    expect(saved.tokens_out).toBe(45);
    expect(saved.tool_name).toBe('exec_command');
    expect(saved.tool_success).toBe(1);
  });

  it('falls back to log body and severity when attrs are sparse', () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  observedTimeUnixNano: '1742600000000000000',
                  severityText: 'WARN',
                  body: { stringValue: 'rate-limited' },
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    };

    const rows = extractOtelEvents(payload, { sourceAgent: 'zeus', provider: 'openai' });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('WARN');
    expect(rows[0].event_type).toBe('rate-limited');
    expect(rows[0].tokens_in).toBe(0);
    expect(rows[0].tokens_out).toBe(0);
  });

  it('drops OTEL SDK noise and websocket chatter while normalizing zero timestamps to now', () => {
    const before = Date.now();
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '0',
                  severityText: 'DEBUG',
                  body: { stringValue: 'flushing OTEL metrics' },
                  attributes: [],
                },
                {
                  timeUnixNano: '0',
                  severityText: 'INFO',
                  body: { kvlistValue: { values: [
                    { key: 'event.name', value: { stringValue: 'codex.websocket_event' } },
                    { key: 'model', value: { stringValue: 'gpt-5.4' } },
                    { key: 'auth_mode', value: { stringValue: 'Chatgpt' } },
                  ] } },
                  attributes: [],
                },
                {
                  timeUnixNano: '0',
                  severityText: 'INFO',
                  body: { kvlistValue: { values: [
                    { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                    { key: 'model', value: { stringValue: 'gpt-5.4' } },
                    { key: 'auth_mode', value: { stringValue: 'Chatgpt' } },
                  ] } },
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    };

    const rows = ingestOtelPayload(getStmts(), payload, { sourceAgent: 'zeus', provider: 'openai' });
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('codex.user_prompt');
    expect(rows[0].auth_mode).toBe('chatgpt');

    const saved = getDb().query('SELECT * FROM otel_events ORDER BY id DESC LIMIT 1').get();
    expect(saved.event_type).toBe('codex.user_prompt');
    expect(saved.timestamp.startsWith('1970-01-01')).toBe(false);
    expect(new Date(saved.timestamp).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('keeps token-bearing usage rows and error rows even without a favored event name', () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1742600000000000000',
                  severityText: 'INFO',
                  body: { stringValue: 'transport update' },
                  attributes: [
                    { key: 'codex.model', value: { stringValue: 'gpt-5.4' } },
                    { key: 'codex.input_tokens', value: { intValue: '321' } },
                    { key: 'codex.output_tokens', value: { intValue: '45' } },
                  ],
                },
                {
                  timeUnixNano: '1742600000000000000',
                  severityText: 'ERROR',
                  body: { stringValue: 'socket blew up' },
                  attributes: [],
                },
                {
                  timeUnixNano: '1742600000000000000',
                  severityText: 'INFO',
                  body: { stringValue: 'codex.websocket_request' },
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    };

    const rows = ingestOtelPayload(getStmts(), payload, { sourceAgent: 'zeus', provider: 'openai' });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.event_type)).toEqual(['transport update', 'socket blew up']);

    const saved = getDb().query('SELECT event_type, tokens_in, tokens_out, status FROM otel_events ORDER BY id').all();
    expect(saved).toEqual([
      { event_type: 'transport update', tokens_in: 321, tokens_out: 45, status: 'INFO' },
      { event_type: 'socket blew up', tokens_in: 0, tokens_out: 0, status: 'ERROR' },
    ]);
  });
});
