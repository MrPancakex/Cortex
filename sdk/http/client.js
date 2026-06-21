/**
 * sdk/http/client.js — canonical gateway fetch helper (S4 home).
 *
 * Provides `gatewayFetch`: a lightweight Node-side fetch wrapper that injects
 * the x-cortex-token auth header and converts any !res.ok response into a
 * typed `GatewayError` so callers never silently swallow upstream failures.
 *
 * This module is Node/server-side only. It relies on the global `fetch`
 * available in Node 18+ (and in Bun). It is NOT imported by the Preact
 * frontend — the browser bundle cannot resolve @cortex/sdk (a workspace
 * package with Node dependencies), so the frontend instead uses its own
 * inline ok-checking wrapper in platform/frontend/src/hooks/useApi.ts.
 * If that wrapper ever needs to grow, it should be extracted to a file under
 * platform/frontend/src/lib/ rather than promoted to this module.
 *
 * Consumers:
 *   - services/gateway/mcp/tools/_shared.js  (gatewayJson → gatewayFetch)
 *   - platform/backend/lib/gateway-client.js (createGatewayClient.request)
 *
 * §3 SSOT: `sdk/http/client.js gatewayFetch` is the canonical HTTP-fetch
 * home per cortex-module-ssot-layout.md.
 */

/**
 * Typed error thrown when the gateway returns a non-2xx response.
 * Callers can `instanceof GatewayError` to distinguish network errors
 * (plain Error, usually ECONNREFUSED) from gateway-level rejections.
 */
export class GatewayError extends Error {
  /**
   * @param {number} status      HTTP status code from the gateway.
   * @param {string} message     Human-readable error message.
   * @param {unknown} body       Parsed response body (may be null).
   */
  constructor(status, message, body = null) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Fetch `url` from the Cortex gateway, injecting `x-cortex-token` when a
 * token is provided, and throwing a `GatewayError` on any !ok response.
 *
 * @param {string} url          Absolute URL to fetch.
 * @param {object} [options]
 * @param {string} [options.token]        Value for the x-cortex-token header.
 * @param {string} [options.agentId]      Value for the x-cortex-session header.
 * @param {string} [options.method]       HTTP method (default: 'GET').
 * @param {unknown} [options.body]        Request body (JSON-serialized when not a string).
 * @param {Record<string,string>} [options.headers]  Extra headers.
 * @returns {Promise<unknown>}   Parsed JSON body on success.
 * @throws {GatewayError}        When the response is !ok.
 * @throws {Error}               When the network call itself fails (ECONNREFUSED etc.).
 */
export async function gatewayFetch(url, { token, agentId, method = 'GET', body, headers: extraHeaders = {} } = {}) {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  if (token) {
    headers['x-cortex-token'] = token;
  }
  if (agentId) {
    headers['x-cortex-session'] = agentId;
  }

  const init = { method, headers };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  // Network errors (ECONNREFUSED, ETIMEDOUT) propagate as plain Errors;
  // callers that need to classify them use platform/backend/lib/gateway-client.js
  // classifyFetchError which handles those codes.
  const res = await fetch(url, init);

  let parsed = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON upstream body: surface as a GatewayError so callers don't
      // silently receive null and assume success.
      if (!res.ok) {
        throw new GatewayError(res.status, `${res.status} ${res.statusText} (non-JSON body)`, null);
      }
      // Unexpected non-JSON on a 2xx — return null; callers that depend on a
      // body will validate it themselves.
      return null;
    }
  }

  if (!res.ok) {
    const message = parsed?.error || parsed?.message || `${res.status} ${res.statusText}`;
    throw new GatewayError(res.status, message, parsed);
  }

  return parsed;
}
