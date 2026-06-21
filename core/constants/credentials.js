/**
 * Credential source surface. Lifted verbatim from
 * `services/gateway/lib/credentials.js:12-18`.
 *
 * `CREDS_DIR` is the systemd `$CREDENTIALS_DIRECTORY` (null outside systemd).
 * `CREDENTIAL_MAP` maps credential-file names on disk to the env var name
 * used as a fallback when systemd credentials aren't mounted.
 */
export const CREDS_DIR = process.env.CREDENTIALS_DIRECTORY || null;

export const CREDENTIAL_MAP = Object.freeze({
  'openai-key':     'OPENAI_API_KEY',
  'anthropic-key':  'ANTHROPIC_API_KEY',
  'openrouter-key': 'OPENROUTER_API_KEY',
});

/**
 * KDF + cipher envelope constants for `sdk/auth/credentials.js`. These
 * describe the on-disk layout of the passphrase-wrapped credential store
 * — the secrets themselves never live in this file.
 *
 * Kept here (not in `sdk/`) so installers, tests, and the platform UI can
 * all agree on the envelope shape without pulling in sdk/auth.
 */
export const CRED_FILE_NAME = 'credentials.enc';
export const CRED_FILE_VERSION = 2;
export const CRED_KDF = 'scrypt';
export const CRED_KDF_PARAMS = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  key_length: 32,
});
export const CRED_CIPHER = 'aes-256-gcm';
export const CRED_NONCE_BYTES = 12;
export const CRED_SALT_BYTES = 16;

export const CRED_KINDS = Object.freeze(['api_key', 'oauth', 'basic', 'token']);
