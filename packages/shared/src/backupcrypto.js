// Encrypting a backup file with a passphrase.
//
// A backup holds every secret Shipdok has (the encryption key and the database), and it is meant to leave the machine, so it can be
// encrypted with a passphrase the administrator chose. AES-256-GCM, the key made from the passphrase with scrypt and a random salt. The
// file is processed as a stream (a backup can be large; nothing is held in memory).
//
//   file = MAGIC (17 bytes) | salt (16) | iv (12) | ciphertext | tag (16)
//
// The magic says what the file is, so an encrypted backup is recognised without a key. Opening fails with ONE vague message: a wrong
// passphrase and a damaged file look the same on purpose.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

export const BACKUP_MAGIC = Buffer.from('SHIPDOK-BACKUP-1\n', 'utf8');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = BACKUP_MAGIC.length + SALT_BYTES + IV_BYTES;
export const BACKUP_KDF = Object.freeze({ N: 2 ** 15, r: 8, p: 1 }); // scrypt's cost: raising it only slows an attacker down more
const SCRYPT = { ...BACKUP_KDF, maxmem: 64 * 1024 * 1024 };
export const BACKUP_PASSPHRASE_MIN = 12;
export const BACKUP_PASSPHRASE_MAX = 256;
const OPEN_FAILED = 'Could not open the backup (wrong passphrase, or the file is damaged)';

const deriveKey = (passphrase, salt) => promisify(scrypt)(Buffer.from(passphrase, 'utf8'), salt, 32, SCRYPT);

/** A message if the passphrase cannot be used, otherwise null. */
export function backupPassphraseProblem(value) {
  if (typeof value !== 'string') return 'Give a passphrase';
  if (value.length < BACKUP_PASSPHRASE_MIN) return `Use at least ${BACKUP_PASSPHRASE_MIN} characters`;
  if (value.length > BACKUP_PASSPHRASE_MAX) return `Use at most ${BACKUP_PASSPHRASE_MAX} characters`;
  if (value.trim() !== value) return 'Do not start or end the passphrase with a space';
  return null;
}

/** True when the file starts with the magic of an encrypted backup. */
export async function isEncryptedBackup(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const head = Buffer.alloc(BACKUP_MAGIC.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && head.equals(BACKUP_MAGIC);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/** Encrypts `from` into `to`. Removes `to` again if anything goes wrong. */
export async function encryptBackupFile(from, to, passphrase) {
  const problem = backupPassphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(BACKUP_MAGIC); // the header is part of what is authenticated
  try {
    const out = createWriteStream(to, { mode: 0o600 });
    out.write(Buffer.concat([BACKUP_MAGIC, salt, iv]));
    await pipeline(createReadStream(from), cipher, out, { end: false });
    await new Promise((resolve, reject) => { out.once('error', reject); out.end(cipher.getAuthTag(), resolve); });
  } catch (err) {
    await rm(to, { force: true });
    throw err;
  }
}

/** Decrypts `from` into `to`. Removes `to` again, and says only that it could not be opened, when the passphrase is wrong or the file is damaged. */
export async function decryptBackupFile(from, to, passphrase) {
  let handle;
  try {
    if (typeof passphrase !== 'string' || passphrase.length === 0) throw new Error('no passphrase');
    const { size } = await stat(from);
    if (size < HEADER_BYTES + TAG_BYTES) throw new Error('too short');
    handle = await open(from, 'r');
    const header = Buffer.alloc(HEADER_BYTES);
    await handle.read(header, 0, HEADER_BYTES, 0);
    if (!header.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error('not an encrypted backup');
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    const salt = header.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + SALT_BYTES);
    const iv = header.subarray(BACKUP_MAGIC.length + SALT_BYTES);
    const key = await deriveKey(passphrase, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(BACKUP_MAGIC);
    decipher.setAuthTag(tag);
    if (size === HEADER_BYTES + TAG_BYTES) {
      decipher.final(); // an empty file: only the tag has something to check
      await writeFile(to, Buffer.alloc(0), { mode: 0o600 });
    } else {
      await pipeline(createReadStream(from, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }), decipher, createWriteStream(to, { mode: 0o600 }));
    }
  } catch {
    await rm(to, { force: true });
    throw new Error(OPEN_FAILED);
  } finally {
    await handle?.close();
  }
}
