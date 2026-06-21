import { MAX_BODY_BYTES } from '../../core/constants/index.js';
import { safeJsonParse } from './json-parse.js';

export function readBody(req, { max = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJsonBody(req, opts) {
  const buf = await readBody(req, opts);
  if (buf.length === 0) return null;
  const parsed = safeJsonParse(buf.toString('utf8'));
  if (parsed.error) {
    const err = new Error('invalid json');
    err.statusCode = 400;
    err.detail = parsed.error;
    throw err;
  }
  return parsed.value;
}
