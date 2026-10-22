import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_KDF, BACKUP_MAGIC, backupPassphraseProblem, decryptBackupFile, encryptBackupFile, isEncryptedBackup } from '../src/backupcrypto.js';

const PASS = 'correct horse battery staple';
let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'bk-')); });
const at = (name) => join(dir, name);
const exists = (p) => stat(p).then(() => true, () => false);

describe('the passphrase', () => {
  test('needs 12 to 256 characters and no space at either end', () => {
    assert.equal(backupPassphraseProblem(PASS), null);
    for (const bad of ['short', 'x'.repeat(11), 'x'.repeat(257), ' leading space ok', 'trailing space ok ', 7, null, undefined]) assert.match(backupPassphraseProblem(bad), /\S/, String(bad));
    assert.equal(backupPassphraseProblem('x'.repeat(12)), null);
    assert.equal(backupPassphraseProblem('x'.repeat(256)), null);
  });
});

describe('encrypting and opening', () => {
  test('what goes in comes out, for small, empty and large files', async () => {
    for (const [name, data] of [['small', Buffer.from('hello backup')], ['empty', Buffer.alloc(0)], ['large', randomBytes(3 * 1024 * 1024 + 17)]]) {
      await writeFile(at(`${name}.in`), data);
      await encryptBackupFile(at(`${name}.in`), at(`${name}.enc`), PASS);
      await decryptBackupFile(at(`${name}.enc`), at(`${name}.out`), PASS);
      assert.ok((await readFile(at(`${name}.out`))).equals(data), name);
    }
  });
  test('the file does not contain the text, starts with the magic, and is recognised without a key', async () => {
    await writeFile(at('t.in'), 'a very recognisable secret sentence');
    await encryptBackupFile(at('t.in'), at('t.enc'), PASS);
    const raw = await readFile(at('t.enc'));
    assert.ok(!raw.includes('recognisable'));
    assert.ok(raw.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC));
    assert.equal(await isEncryptedBackup(at('t.enc')), true);
    assert.equal(await isEncryptedBackup(at('t.in')), false);
    assert.equal(await isEncryptedBackup(at('does-not-exist')), false);
  });
  test('two encryptions of the same file differ (a new salt and iv each time)', async () => {
    await writeFile(at('r.in'), 'same');
    await encryptBackupFile(at('r.in'), at('r1.enc'), PASS);
    await encryptBackupFile(at('r.in'), at('r2.enc'), PASS);
    assert.ok(!(await readFile(at('r1.enc'))).equals(await readFile(at('r2.enc'))));
  });
  test('every file has its own salt and iv (the 16 bytes and the 12 bytes after the magic)', async () => {
    await writeFile(at('s.in'), 'same');
    const heads = [];
    for (const n of ['s1', 's2', 's3']) { await encryptBackupFile(at('s.in'), at(`${n}.enc`), PASS); heads.push((await readFile(at(`${n}.enc`))).subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + 28)); }
    assert.equal(new Set(heads.map((h) => h.subarray(0, 16).toString('hex'))).size, 3, 'salts');
    assert.equal(new Set(heads.map((h) => h.subarray(16).toString('hex'))).size, 3, 'ivs');
    for (const h of heads) { assert.ok(!h.subarray(0, 16).equals(Buffer.alloc(16))); assert.ok(!h.subarray(16).equals(Buffer.alloc(12))); }
  });
  test('the key is made with scrypt at a cost of at least 2^15', () => {
    assert.ok(BACKUP_KDF.N >= 2 ** 15 && BACKUP_KDF.r >= 8 && BACKUP_KDF.p >= 1);
  });
  test('an empty file is protected too: a changed tag is refused', async () => {
    await writeFile(at('e.in'), Buffer.alloc(0));
    await encryptBackupFile(at('e.in'), at('e.enc'), PASS);
    const good = await readFile(at('e.enc'));
    const bad = Buffer.from(good); bad[bad.length - 1] ^= 0x01;
    await writeFile(at('e.bad'), bad);
    await assert.rejects(decryptBackupFile(at('e.bad'), at('e.out'), PASS), /Could not open/);
    await assert.rejects(decryptBackupFile(at('e.enc'), at('e.out2'), 'a wrong passphrase!!'), /Could not open/);
  });
  test('a wrong passphrase is refused with one vague message, and leaves no output file', async () => {
    await writeFile(at('w.in'), 'secret');
    await encryptBackupFile(at('w.in'), at('w.enc'), PASS);
    for (const bad of ['wrong passphrase here', '', undefined]) {
      await assert.rejects(decryptBackupFile(at('w.enc'), at('w.out'), bad), /Could not open the backup \(wrong passphrase, or the file is damaged\)/);
      assert.equal(await exists(at('w.out')), false);
    }
  });
  test('a changed byte anywhere (header, body or tag) is refused', async () => {
    await writeFile(at('c.in'), randomBytes(5000));
    await encryptBackupFile(at('c.in'), at('c.enc'), PASS);
    const good = await readFile(at('c.enc'));
    for (const index of [3, BACKUP_MAGIC.length + 2, BACKUP_MAGIC.length + 20, 100, good.length - 20, good.length - 1]) {
      const bad = Buffer.from(good); bad[index] ^= 0x01;
      await writeFile(at('c.bad'), bad);
      await assert.rejects(decryptBackupFile(at('c.bad'), at('c.out'), PASS), /Could not open/, `byte ${index}`);
      assert.equal(await exists(at('c.out')), false);
    }
  });
  test('a truncated or foreign file is refused', async () => {
    await writeFile(at('f.in'), randomBytes(2000));
    await encryptBackupFile(at('f.in'), at('f.enc'), PASS);
    const good = await readFile(at('f.enc'));
    for (const bad of [good.subarray(0, good.length - 1), good.subarray(0, 40), Buffer.alloc(0), randomBytes(500), Buffer.from('just text')]) {
      await writeFile(at('f.bad'), bad);
      await assert.rejects(decryptBackupFile(at('f.bad'), at('f.out'), PASS), /Could not open/);
    }
    await assert.rejects(decryptBackupFile(at('no-such-file'), at('f.out'), PASS), /Could not open/);
  });
  test('encrypting refuses a bad passphrase and leaves nothing behind; the output is private to the user', async () => {
    await writeFile(at('p.in'), 'x');
    await assert.rejects(encryptBackupFile(at('p.in'), at('p.enc'), 'short'), /at least 12/);
    assert.equal(await exists(at('p.enc')), false);
    await assert.rejects(encryptBackupFile(at('no-input'), at('p2.enc'), PASS));
    assert.equal(await exists(at('p2.enc')), false);
    await encryptBackupFile(at('p.in'), at('p3.enc'), PASS);
    assert.equal((await stat(at('p3.enc'))).mode & 0o077, 0);
  });
});
