import { PLATFORM_PORT } from '../../core/constants/index.js';

const DEFAULT_ORIGINS = [
  `http://localhost:${PLATFORM_PORT}`,
  `http://127.0.0.1:${PLATFORM_PORT}`,
];
const DEFAULT_HEADERS = ['authorization', 'content-type', 'x-cortex-agent', 'x-cortex-session'];

export function applyCors(res, origin, { origins = DEFAULT_ORIGINS, headers = DEFAULT_HEADERS } = {}) {
  // Only reflect explicitly-allowed origins. For anything else we leave the
  // `Access-Control-Allow-Origin` header unset — browsers will then block
  // the response, which is the right fail-closed behavior. Reflecting
  // `origins[0]` on a mismatch (the prior draft) looked like an accidental
  // whitelist and confused reviewers.
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', headers.join(', '));
  res.setHeader('vary', 'origin');
  if (origin && origins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
  }
}

export function cors(options = {}) {
  return function corsMiddleware(req, res, next) {
    applyCors(res, req.headers?.origin, options);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  };
}
