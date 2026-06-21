/**
 * Thin response helpers. No framework assumptions — they work against the
 * raw Node ServerResponse. Every helper sets status, JSON body, and a
 * sensible Content-Type, then ends the response.
 */
function send(res, status, payload) {
  if (res.headersSent) return;
  res.statusCode = status;
  if (payload === undefined || payload === null) {
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export const ok           = (res, body)    => send(res, 200, body ?? { ok: true });
export const created      = (res, body)    => send(res, 201, body);
export const noContent    = (res)          => send(res, 204, null);
export const badRequest   = (res, message, detail) =>
  send(res, 400, { error: 'bad_request', message, detail });
export const unauthorized = (res, message) => send(res, 401, { error: 'unauthorized', message });
export const forbidden    = (res, message) => send(res, 403, { error: 'forbidden', message });
export const notFound     = (res, message) => send(res, 404, { error: 'not_found', message });
export const conflict     = (res, message) => send(res, 409, { error: 'conflict', message });
export const serverError  = (res, message) => send(res, 500, { error: 'server_error', message });
