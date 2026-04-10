import { calcCostUsd } from './proxy.js';

function anyValueToJs(value) {
  if (!value || typeof value !== 'object') return value ?? null;
  if ('stringValue' in value) return value.stringValue;
  if ('boolValue' in value) return Boolean(value.boolValue);
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('bytesValue' in value) return value.bytesValue;
  if ('arrayValue' in value) {
    const values = value.arrayValue?.values || [];
    return values.map(anyValueToJs);
  }
  if ('kvlistValue' in value) {
    const out = {};
    for (const entry of value.kvlistValue?.values || []) {
      if (!entry?.key) continue;
      out[entry.key] = anyValueToJs(entry.value);
    }
    return out;
  }
  return null;
}

function attrsToObject(attrs) {
  const out = {};
  for (const attr of attrs || []) {
    if (!attr?.key) continue;
    out[attr.key] = anyValueToJs(attr.value);
  }
  return out;
}

function firstValue(obj, keys, fallback = null) {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function numericValue(obj, keys, fallback = 0) {
  const value = firstValue(obj, keys, fallback);
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function boolToInt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'ok' || lower === 'success') return 1;
    if (lower === 'false' || lower === '0' || lower === 'error' || lower === 'failed') return 0;
  }
  return null;
}

function timeUnixNanoToIso(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString();
  try {
    const nanos = BigInt(value);
    if (nanos <= 0n) return new Date().toISOString();
    const ms = nanos / 1_000_000n;
    return new Date(Number(ms)).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function eventBodyToText(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  if (typeof body === 'number' || typeof body === 'boolean') return String(body);
  try {
    return JSON.stringify(body);
  } catch {
    return null;
  }
}

function normalizeAuthMode(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return String(value);
  return value.trim().toLowerCase();
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isErrorStatus(value) {
  if (value == null || value === '') return false;
  const normalized = String(value).trim().toLowerCase();
  return ['error', 'fatal', 'failed'].includes(normalized);
}

function isMeaningfulEventType(value) {
  if (value == null || value === '') return false;
  const eventType = String(value).trim().toLowerCase();
  if (eventType === 'codex.user_prompt') return true;
  if (eventType.includes('tool.call')) return true;
  if (eventType.includes('tool.result')) return true;
  if (eventType.includes('tool.error')) return true;
  if (eventType.includes('usage')) return true;
  if (eventType.includes('token')) return true;
  if (eventType.includes('result')) return true;
  if (eventType.includes('response')) return true;
  if (eventType.includes('error')) return true;
  if (eventType.includes('failed')) return true;
  if (eventType.includes('exception')) return true;
  return false;
}

function shouldPersistRow(row) {
  if (!row) return false;
  if (row.event_type === 'flushing OTEL metrics') return false;
  if (isErrorStatus(row.status)) return true;
  if (row.tokens_in > 0 || row.tokens_out > 0) return true;
  if (row.tool_name) return true;
  if (row.tool_success !== null) return true;
  return isMeaningfulEventType(row.event_type);
}

function normalizeLogRecord(record, mergedAttrs, defaults) {
  const bodyValue = anyValueToJs(record.body);
  const bodyAttrs = isPlainObject(bodyValue) ? bodyValue : {};
  const fields = { ...bodyAttrs, ...mergedAttrs };

  const model = firstValue(fields, ['codex.model', 'model'], null);
  const tokensIn = numericValue(fields, [
    'codex.input_tokens',
    'input_tokens',
    'prompt_tokens',
    'codex.prompt_tokens',
  ], 0);
  const tokensOut = numericValue(fields, [
    'codex.output_tokens',
    'output_tokens',
    'completion_tokens',
    'codex.completion_tokens',
  ], 0);

  return {
    source_agent: defaults.sourceAgent,
    provider: defaults.provider,
    run_id: firstValue(fields, ['codex.run_id', 'run_id', 'run.id', 'turn.id', 'trace_id'], record.traceId || null),
    thread_id: firstValue(fields, ['codex.thread_id', 'thread_id', 'thread.id', 'session.id'], null),
    model,
    auth_mode: normalizeAuthMode(firstValue(fields, ['codex.auth_mode', 'auth_mode'], null)),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: calcCostUsd(model, tokensIn, tokensOut),
    latency_ms: numericValue(fields, ['codex.latency_ms', 'latency_ms'], 0),
    status: firstValue(fields, ['codex.request_status', 'request_status', 'status'], record.severityText || null),
    tool_name: firstValue(fields, ['codex.tool_name', 'tool_name'], null),
    tool_success: boolToInt(firstValue(fields, ['codex.tool_success', 'tool_success'], null)),
    event_type: firstValue(
      fields,
      ['otel.name', 'event.name', 'codex.event_type'],
      eventBodyToText(bodyValue) || record.severityText || 'log'
    ),
    timestamp: timeUnixNanoToIso(record.timeUnixNano || record.observedTimeUnixNano),
  };
}

export function extractOtelEvents(payload, defaults = {}) {
  const sourceAgent = defaults.sourceAgent || 'unknown';
  const provider = defaults.provider || 'unknown';
  const rows = [];

  for (const resourceLog of payload?.resourceLogs || []) {
    const resourceAttrs = attrsToObject(resourceLog?.resource?.attributes);

    for (const scopeLog of resourceLog?.scopeLogs || []) {
      const scopeAttrs = attrsToObject(scopeLog?.scope?.attributes);

      for (const record of scopeLog?.logRecords || []) {
        const recordAttrs = attrsToObject(record?.attributes);
        rows.push(
          normalizeLogRecord(
            record,
            { ...resourceAttrs, ...scopeAttrs, ...recordAttrs },
            { sourceAgent, provider }
          )
        );
      }
    }
  }

  return rows;
}

export function ingestOtelPayload(stmts, payload, defaults = {}) {
  const rows = extractOtelEvents(payload, defaults);
  for (const row of rows) {
    if (!shouldPersistRow(row)) continue;
    stmts.insertOtelEvent.run(
      row.source_agent,
      row.provider,
      row.run_id,
      row.thread_id,
      row.model,
      row.auth_mode,
      row.tokens_in,
      row.tokens_out,
      row.cost_usd,
      row.latency_ms,
      row.status,
      row.tool_name,
      row.tool_success,
      row.event_type,
      row.timestamp
    );
  }
  return rows.filter(shouldPersistRow);
}

export async function handleOtlpHttpLogs(req, stmts, defaults = {}) {
  const contentType = (req.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('application/x-protobuf')) {
    return Response.json(
      {
        ok: false,
        error: 'OTLP protobuf is not supported by this receiver yet. Configure the sender for JSON/HTTP export.',
      },
      { status: 415 }
    );
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid OTLP JSON payload' }, { status: 400 });
  }

  const rows = ingestOtelPayload(stmts, payload, defaults);
  return Response.json({ ok: true, ingested: rows.length });
}
