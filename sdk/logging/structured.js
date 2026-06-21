import {
  LOG_LEVELS,
  LOG_LEVEL_RANK,
  DEFAULT_LOG_LEVEL,
  LOG_REDACT_FIELDS,
  LOG_RESOURCE_KEYS,
} from '@cortex/core/constants';
import { swallow } from '../errors/index.js';

/**
 * Minimal structured logger. Emits one JSON object per line to stdout.
 * Downstream collectors (OTel, fluent-bit) parse it without additional
 * framing. We deliberately do not depend on pino/winston — the format is
 * small enough to own.
 */
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (LOG_REDACT_FIELDS.includes(k.toLowerCase())) {
      out[k] = '[REDACTED]';
      continue;
    }
    out[k] = v && typeof v === 'object' ? redact(v) : v;
  }
  return out;
}

function writeLine(level, resource, payload, message) {
  const record = {
    ts: new Date().toISOString(),
    level,
    ...resource,
    ...redact(payload || {}),
    msg: message,
  };
  try {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch (err) {
    swallow('logging.write_failed', err);
  }
}

export function createLogger({ level = DEFAULT_LOG_LEVEL, resource = LOG_RESOURCE_KEYS, bindings = {} } = {}) {
  const threshold = LOG_LEVEL_RANK[level] ?? LOG_LEVEL_RANK.info;
  const api = {
    level,
    child(extra) {
      return createLogger({ level, resource, bindings: { ...bindings, ...extra } });
    },
  };
  for (const lvl of LOG_LEVELS) {
    api[lvl] = (payload, message) => {
      if (LOG_LEVEL_RANK[lvl] < threshold) return;
      if (typeof payload === 'string') {
        message = payload;
        payload = {};
      }
      writeLine(lvl, resource, { ...bindings, ...payload }, message || '');
    };
  }
  return api;
}

export const rootLogger = createLogger();

/**
 * Publish a logger instance so `swallow()` can reach it without creating an
 * import cycle through `sdk/errors`. Exposed as an explicit setter so tests
 * (and callers that want to replace the root logger with a richer one) can
 * swap the global without relying on module-load order.
 *
 * A convenience call is issued below on load so the default wire-up matches
 * the spec: downstream code that never calls `setRootLogger()` still gets
 * the minimal structured logger.
 */
export function setRootLogger(logger) {
  globalThis.__cortex_log = logger;
}

setRootLogger(rootLogger);
