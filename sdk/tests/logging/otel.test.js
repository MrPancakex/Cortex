/**
 * Tests for sdk/logging/otel.js (otelBridge)
 * Covers: no-op when endpoint not set, passthrough to logger,
 *         tee to OTLP endpoint, swallow on fetch failure
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { otelBridge } from '../../logging/otel.js';

const _originalFetch = globalThis.fetch;

function makeLogger() {
  const calls = [];
  return {
    calls,
    error: (payload, message) => calls.push({ level: 'error', payload, message }),
    info: (payload, message) => calls.push({ level: 'info', payload, message }),
  };
}

beforeEach(() => {
  delete process.env.CORTEX_OTEL_ENDPOINT;
});

afterEach(() => {
  delete process.env.CORTEX_OTEL_ENDPOINT;
  globalThis.fetch = _originalFetch;
});

describe('otelBridge', () => {
  test('should return the original logger unchanged when CORTEX_OTEL_ENDPOINT is not set', () => {
    const logger = makeLogger();
    const result = otelBridge(logger);
    expect(result).toBe(logger);
  });

  test('should return a modified logger when CORTEX_OTEL_ENDPOINT is set', () => {
    process.env.CORTEX_OTEL_ENDPOINT = 'http://otel.local:4318/v1/logs';
    const logger = makeLogger();
    const result = otelBridge(logger);
    expect(result).toBe(logger); // same object, mutated
    expect(result.error).not.toBe(makeLogger().error); // method replaced
  });

  test('should still call the original logger.error when the bridge fires', async () => {
    process.env.CORTEX_OTEL_ENDPOINT = 'http://otel.local:4318/v1/logs';
    // Intercept fetch so we don't make real network calls
    const fetchCalls = [];
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true };
    };
    const logger = makeLogger();
    otelBridge(logger);
    logger.error({ code: 500 }, 'test error');
    expect(logger.calls.length).toBe(1);
    expect(logger.calls[0].message).toBe('test error');
  });

  test('should send a POST to the OTLP endpoint when error is logged', async () => {
    process.env.CORTEX_OTEL_ENDPOINT = 'http://otel.local:4318/v1/logs';
    const fetchCalls = [];
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true };
    };
    const logger = makeLogger();
    otelBridge(logger);
    logger.error({ service: 'test' }, 'something failed');
    // fetch is async — give microtasks a chance to run
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe('http://otel.local:4318/v1/logs');
    expect(fetchCalls[0].opts.method).toBe('POST');
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.resourceLogs).toBeDefined();
  });

  test('should include the error message in the OTLP body', async () => {
    process.env.CORTEX_OTEL_ENDPOINT = 'http://otel.local:4318/v1/logs';
    let capturedBody;
    globalThis.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true };
    };
    const logger = makeLogger();
    otelBridge(logger);
    logger.error({}, 'my-error-message');
    await new Promise((r) => setTimeout(r, 10));
    const record = capturedBody.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.body.stringValue).toBe('my-error-message');
    expect(record.severityText).toBe('ERROR');
  });

  test('should swallow fetch failures without propagating', async () => {
    process.env.CORTEX_OTEL_ENDPOINT = 'http://otel.local:4318/v1/logs';
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    const logger = makeLogger();
    otelBridge(logger);
    // Should not throw
    expect(() => logger.error({}, 'boom')).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });

  test('should handle null/undefined payload gracefully', async () => {
    process.env.CORTEX_OTEL_ENDPOINT = 'http://otel.local:4318/v1/logs';
    const fetchCalls = [];
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push(JSON.parse(opts.body));
      return { ok: true };
    };
    const logger = makeLogger();
    otelBridge(logger);
    logger.error(null, 'null payload');
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCalls.length).toBe(1);
  });
});
