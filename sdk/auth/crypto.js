import crypto from 'node:crypto';

export const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function deriveBearer(value) {
  const token = String(value ?? '').trim();
  if (!token) return '';
  return SHA256_HEX_RE.test(token) ? token.toLowerCase() : sha256Hex(token);
}

export function hashSecret(value, { salt } = {}) {
  const s = salt || crypto.randomBytes(16);
  const hash = crypto.scryptSync(value, s, 64);
  return { salt: s.toString('base64url'), hash: hash.toString('base64url') };
}

export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
