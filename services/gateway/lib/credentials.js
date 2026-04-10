/**
 * Credential loader — reads secrets from $CREDENTIALS_DIRECTORY (systemd LoadCredential)
 * with env var fallback for dev/non-systemd environments.
 *
 * Credentials are cached after first read. Cache is cleared on SIGHUP
 * (systemctl reload) so credential rotation takes effect without restart.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CREDS_DIR = process.env.CREDENTIALS_DIRECTORY || null;

const CREDENTIAL_MAP = {
  'openai-key':     'OPENAI_API_KEY',
  'anthropic-key':  'ANTHROPIC_API_KEY',
  'openrouter-key': 'OPENROUTER_API_KEY',
};

const _cache = new Map();

// Clear cache on SIGHUP so rotated credentials are re-read
process.on('SIGHUP', () => {
  _cache.clear();
});

/**
 * Read a named credential. Tries $CREDENTIALS_DIRECTORY first (systemd LoadCredential),
 * then falls back to the mapped environment variable.
 * Returns the credential string or null.
 */
export function readCredential(name) {
  if (_cache.has(name)) return _cache.get(name);

  let value = null;

  // Try LoadCredential directory first
  if (CREDS_DIR) {
    try {
      value = readFileSync(join(CREDS_DIR, name), 'utf8').trim();
    } catch { /* file not found or unreadable — fall through */ }
  }

  // Fall back to env var
  if (!value) {
    const envName = CREDENTIAL_MAP[name];
    value = envName ? (process.env[envName] || null) : null;
  }

  _cache.set(name, value);

  if (value) {
    console.log(`[credentials] loaded: ${name} (${CREDS_DIR ? 'LoadCredential' : 'env var'})`);
  }

  return value;
}

/**
 * Determine credential mode from request headers.
 * passthrough = caller sent their own auth, forward it
 * managed = no caller auth, Cortex attaches its own credentials
 */
export function resolveCredentialMode(req) {
  const hasCallerAuth = req.headers.get('authorization') || req.headers.get('x-api-key');
  return hasCallerAuth ? 'passthrough' : 'managed';
}
