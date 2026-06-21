import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { swallow } from '../errors/index.js';
import {
  resolveStateRoot,
  CRED_FILE_NAME,
  CRED_FILE_VERSION,
  CRED_CIPHER,
  CRED_NONCE_BYTES,
  CRED_SALT_BYTES,
} from '@cortex/core/constants';

function credPath(root) {
  return path.join(resolveStateRoot(root), CRED_FILE_NAME);
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32);
}

function readEnvelope(root) {
  try {
    const raw = fs.readFileSync(credPath(root));
    return JSON.parse(raw.toString('utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') swallow('creds.read_envelope_failed', err);
    return { version: CRED_FILE_VERSION, records: {}, salt: null };
  }
}

function writeEnvelope(envelope, root) {
  const p = credPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function loadCredentials({ passphrase, root } = {}) {
  const env = readEnvelope(root);
  if (!passphrase || !env.salt) return env.records;
  const key = deriveKey(passphrase, Buffer.from(env.salt, 'base64url'));
  const out = {};
  for (const [id, rec] of Object.entries(env.records)) {
    if (!rec.encrypted) {
      out[id] = rec;
      continue;
    }
    try {
      const nonce = Buffer.from(rec.nonce, 'base64url');
      const ct = Buffer.from(rec.ciphertext, 'base64url');
      const decipher = crypto.createDecipheriv(CRED_CIPHER, key, nonce);
      // GCM REQUIRES the auth tag to be set before `final()` — without it
      // the decrypt step cannot verify integrity and throws "unable to
      // authenticate data". Records written by `saveCredentials` carry
      // `auth_tag`; older records without one are unreadable and flagged.
      if (!rec.auth_tag) {
        throw new Error(`credential record ${id} missing auth_tag (pre-GCM-fix envelope?)`);
      }
      decipher.setAuthTag(Buffer.from(rec.auth_tag, 'base64url'));
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      out[id] = { ...rec, value: JSON.parse(pt.toString('utf8')), encrypted: false };
    } catch (err) {
      swallow('creds.decrypt_failed', err);
    }
  }
  return out;
}

export function saveCredentials(record, { passphrase, root } = {}) {
  const env = readEnvelope(root);
  if (!env.salt) env.salt = crypto.randomBytes(CRED_SALT_BYTES).toString('base64url');
  if (!passphrase) {
    env.records[record.id] = { ...record, encrypted: false };
  } else {
    const key = deriveKey(passphrase, Buffer.from(env.salt, 'base64url'));
    const nonce = crypto.randomBytes(CRED_NONCE_BYTES);
    const cipher = crypto.createCipheriv(CRED_CIPHER, key, nonce);
    const pt = Buffer.from(JSON.stringify(record.value), 'utf8');
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    // GCM authentication tag — must be captured after `final()` and stored
    // alongside the ciphertext so `loadCredentials` can verify integrity.
    const authTag = cipher.getAuthTag();
    env.records[record.id] = {
      id: record.id,
      kind: record.kind,
      provider: record.provider,
      encrypted: true,
      nonce: nonce.toString('base64url'),
      ciphertext: ct.toString('base64url'),
      auth_tag: authTag.toString('base64url'),
      created_at: record.created_at || new Date().toISOString(),
    };
  }
  writeEnvelope(env, root);
}

export function deleteCredential(id, { root } = {}) {
  const env = readEnvelope(root);
  delete env.records[id];
  writeEnvelope(env, root);
}
