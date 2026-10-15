import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { parseMasterKey, envVarContext, encryptSecret, decryptSecret } from '../src/index.js';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const CTX = envVarContext('app-1', 'DATABASE_URL');
const FAIL = /Could not decrypt secret/;

describe('round trip', () => {
  for (const [label, value] of [
    ['a typical connection string', 'postgres://user:p@ss:w0rd@db.internal:5432/app?sslmode=require'],
    ['the empty string', ''],
    ['unicode', 'pässwörd-密码-🔑'],
    ['a value containing the separator', 'a:b:c:d'],
    ['multiline text (a PEM-like blob)', '-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----\n'],
    ['a 100 KB value', 'x'.repeat(100 * 1024)],
  ]) {
    test(`encrypts and decrypts ${label}`, () => {
      assert.equal(decryptSecret(encryptSecret(value, KEY, CTX), KEY, CTX), value);
    });
  }
});

describe('what is stored', () => {
  test('uses the versioned v1 format with four parts', () => {
    const token = encryptSecret('hunter2', KEY, CTX);
    assert.match(token, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/);
    assert.equal(token.split(':').length, 4);
  });

  test('never contains the plaintext', () => {
    const secret = 'super-secret-database-password';
    const token = encryptSecret(secret, KEY, CTX);
    assert.ok(!token.includes(secret));
    assert.ok(!Buffer.from(token.split(':')[3], 'base64').toString('utf8').includes(secret));
  });

  test('uses a fresh IV every time, so equal values never look equal', () => {
    const a = encryptSecret('same', KEY, CTX);
    const b = encryptSecret('same', KEY, CTX);
    assert.notEqual(a, b);
    assert.notEqual(a.split(':')[1], b.split(':')[1]);
  });
});

describe('failure modes: all give the same vague error', () => {
  const token = encryptSecret('top-secret', KEY, CTX);
  const flip = (b64) => {
    const buf = Buffer.from(b64, 'base64');
    buf[0] ^= 0x01;
    return buf.toString('base64');
  };

  test('wrong key', () => assert.throws(() => decryptSecret(token, OTHER_KEY, CTX), FAIL));

  test('wrong context: a value cannot be moved to another app', () =>
    assert.throws(() => decryptSecret(token, KEY, envVarContext('app-2', 'DATABASE_URL')), FAIL));

  test('wrong context: a value cannot be moved to another variable name', () =>
    assert.throws(() => decryptSecret(token, KEY, envVarContext('app-1', 'API_KEY')), FAIL));

  for (const [i, name] of [[1, 'IV'], [2, 'auth tag'], [3, 'ciphertext']]) {
    test(`tampered ${name}`, () => {
      const parts = token.split(':');
      parts[i] = flip(parts[i]);
      assert.throws(() => decryptSecret(parts.join(':'), KEY, CTX), FAIL);
    });
  }

  for (const [label, bad] of [
    ['an unknown version', token.replace(/^v1/, 'v2')],
    ['too few parts', 'v1:abc:def'],
    ['too many parts', `${token}:extra`],
    ['an empty string', ''],
    ['undefined', undefined],
    ['plain text', 'just-a-password'],
    ['wrong IV length', `v1:${Buffer.alloc(4).toString('base64')}:${token.split(':')[2]}:${token.split(':')[3]}`],
  ]) {
    test(`malformed token: ${label}`, () => assert.throws(() => decryptSecret(bad, KEY, CTX), FAIL));
  }

  test('error messages never contain the secret, the key or the token', () => {
    try {
      decryptSecret(token, OTHER_KEY, CTX);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(!err.message.includes('top-secret'));
      assert.ok(!err.message.includes(OTHER_KEY.toString('hex')));
      assert.ok(!err.message.includes(token));
    }
  });
});

describe('input checks', () => {
  test('rejects keys that are not 32-byte Buffers', () => {
    assert.throws(() => encryptSecret('x', randomBytes(16), CTX), /32-byte/);
    assert.throws(() => encryptSecret('x', KEY.toString('hex'), CTX), /32-byte/);
    assert.throws(() => decryptSecret('v1:a:b:c', null, CTX), /32-byte/);
  });

  test('requires a context, so values are always bound', () => {
    assert.throws(() => encryptSecret('x', KEY), /context/);
    assert.throws(() => encryptSecret('x', KEY, ''), /context/);
    assert.throws(() => decryptSecret('v1:a:b:c', KEY, undefined), /context/);
  });

  test('only encrypts strings', () => {
    assert.throws(() => encryptSecret(123, KEY, CTX), /string/);
    assert.throws(() => encryptSecret(null, KEY, CTX), /string/);
  });
});

describe('parseMasterKey', () => {
  const hex = randomBytes(32).toString('hex');

  test('accepts 64 hex characters, in either case, with surrounding whitespace', () => {
    assert.equal(parseMasterKey(hex).length, 32);
    assert.equal(parseMasterKey(hex.toUpperCase()).toString('hex'), hex);
    assert.equal(parseMasterKey(`  ${hex}\n`).toString('hex'), hex);
  });

  for (const [label, bad] of [
    ['missing', undefined],
    ['empty', ''],
    ['too short', hex.slice(0, 62)],
    ['too long', `${hex}00`],
    ['not hex', 'z'.repeat(64)],
    ['the placeholder from .env.example', 'change-me-to-64-hex-characters'],
  ]) {
    test(`rejects a key that is ${label}`, () => assert.throws(() => parseMasterKey(bad), /64 hex characters/));
  }

  test('the error never echoes the rejected value', () => {
    const attempt = 'my-real-looking-but-invalid-key-material';
    try {
      parseMasterKey(attempt);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(!err.message.includes(attempt));
    }
  });
});
