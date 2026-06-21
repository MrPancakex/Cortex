/**
 * Safe JSON parse. Returns { value } or { error } — never throws so the
 * caller can decide on the HTTP status.
 */
export function safeJsonParse(input) {
  try {
    return { value: JSON.parse(input) };
  } catch (err) {
    return { error: { message: err.message } };
  }
}
