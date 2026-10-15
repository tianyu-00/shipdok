// Encryption for application secrets (environment variable values).
//
// AES-256-GCM with a random 96-bit IV per value. Each value is bound to a "context"
// string (which app and which variable) as authenticated data, so a ciphertext copied
// into a different row fails to decrypt instead of silently becoming another secret.
//
// Stored format:  v1:<iv>:<tag>:<ciphertext>   (each part base64; ":" is not in the base64 alphabet)
// The "v1" prefix leaves room for key rotation later.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

// Turn the APP_SECRETS_KEY environment value into a 32-byte key. Never echoes the input.
export function parseMasterKey(hex) {
  if (typeof hex !== 'string' || !KEY_HEX_RE.test(hex.trim())) {
    throw new Error('APP_SECRETS_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
  }
  return Buffer.from(hex.trim(), 'hex');
}

// Context string binding a value to one variable of one app.
export function envVarContext(appId, name) {
  return `env:${appId}:${name}`;
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError('Encryption key must be a 32-byte Buffer (use parseMasterKey)');
  }
}

function assertContext(context) {
  if (typeof context !== 'string' || context.length === 0) {
    throw new TypeError('A non-empty context string is required (use envVarContext)');
  }
}

export function encryptSecret(plaintext, key, context) {
  if (typeof plaintext !== 'string') throw new TypeError('Secret value must be a string');
  assertKey(key);
  assertContext(context);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext].map((p, i) => (i === 0 ? p : p.toString('base64'))).join(':');
}

// One deliberately vague error: callers (and logs) learn nothing about WHY it failed.
const DECRYPT_FAILED = 'Could not decrypt secret (wrong key, wrong context, or corrupted data)';

export function decryptSecret(token, key, context) {
  assertKey(key);
  assertContext(context);
  try {
    const parts = String(token).split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('bad format');
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('bad lengths');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(DECRYPT_FAILED);
  }
}
