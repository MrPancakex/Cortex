/**
 * Optional OpenTelemetry bridge. When `CORTEX_OTEL_ENDPOINT` is set we tee
 * structured log records to an OTLP/HTTP exporter. Kept as a thin forwarder
 * so absence of the endpoint is a no-op, not an error.
 */
import { swallow } from '../errors/index.js';

export function otelBridge(logger) {
  const endpoint = process.env.CORTEX_OTEL_ENDPOINT;
  if (!endpoint) return logger;

  const originalError = logger.error;
  logger.error = (payload, message) => {
    originalError(payload, message);
    send(endpoint, payload, message).catch((err) => swallow('otel.forward_failed', err));
  };
  return logger;
}

async function send(endpoint, payload, message) {
  const body = JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [] },
        scopeLogs: [
          {
            scope: { name: 'cortex' },
            logRecords: [
              {
                timeUnixNano: `${Date.now() * 1_000_000}`,
                severityText: 'ERROR',
                body: { stringValue: message || '' },
                attributes: Object.entries(payload || {}).map(([k, v]) => ({
                  key: k,
                  value: { stringValue: String(v) },
                })),
              },
            ],
          },
        ],
      },
    ],
  });
  await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}
