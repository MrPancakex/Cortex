/**
 * Logging surface. `ROTATION_ESCALATE_AFTER` is lifted verbatim from
 * `services/gateway/lib/log-manager.js:17` — after that many consecutive
 * rotation failures the stream escalates to a critical-level warning so
 * operators see log degradation even when the `/health.degraded` surface
 * is missed.
 */
export const ROTATION_ESCALATE_AFTER = 3;

export const LOG_LEVELS = Object.freeze(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export const LOG_LEVEL_RANK = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

export const DEFAULT_LOG_LEVEL = process.env.CORTEX_LOG_LEVEL || 'info';

// Fields we never let a caller include — PII or secrets.
export const LOG_REDACT_FIELDS = Object.freeze([
  'password',
  'token',
  'api_key',
  'apiKey',
  'authorization',
  'cookie',
  'set-cookie',
  'secret',
]);

// OTel resource attributes emitted on every log.
export const LOG_RESOURCE_KEYS = Object.freeze({
  service_name: 'cortex',
  service_version: process.env.CORTEX_VERSION || '0.2.0',
});
