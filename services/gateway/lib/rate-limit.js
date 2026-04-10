/**
 * In-memory sliding-window rate limiter for the Cortex gateway.
 *
 * Two tiers:
 *   - Auth failures: 60 per minute per IP (prevents brute-force token guessing)
 *   - Normal operations: 100 per minute per agent token
 *
 * Counts reset every 60 seconds via a periodic sweep.
 */

const WINDOW_MS = 60_000; // 1 minute

const AUTH_FAIL_LIMIT = Number(process.env.CORTEX_RATE_AUTH_FAIL || 60);
const AGENT_REQ_LIMIT = Number(process.env.CORTEX_RATE_AGENT_REQ || 100);

// key -> { count, windowStart }
const authFailBuckets = new Map();
const agentReqBuckets = new Map();

function getBucket(map, key) {
  const now = Date.now();
  let bucket = map.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    map.set(key, bucket);
  }
  return bucket;
}

/**
 * Record an auth failure for the given IP.
 * Returns true if the request should be rejected (over limit).
 */
export function checkAuthFailRate(ip) {
  if (!ip) return false;
  const bucket = getBucket(authFailBuckets, ip);
  bucket.count++;
  return bucket.count > AUTH_FAIL_LIMIT;
}

/**
 * Record a normal request for the given agent identity.
 * Returns true if the request should be rejected (over limit).
 */
export function checkAgentRate(agentId) {
  if (!agentId) return false;
  const bucket = getBucket(agentReqBuckets, agentId);
  bucket.count++;
  return bucket.count > AGENT_REQ_LIMIT;
}

/**
 * Periodic cleanup — drop stale buckets older than 2 windows.
 */
function sweep(map) {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [key, bucket] of map) {
    if (bucket.windowStart < cutoff) map.delete(key);
  }
}

// Sweep every 60 seconds
const _sweepInterval = setInterval(() => {
  sweep(authFailBuckets);
  sweep(agentReqBuckets);
}, WINDOW_MS);

// Allow the process to exit cleanly
if (_sweepInterval.unref) _sweepInterval.unref();
