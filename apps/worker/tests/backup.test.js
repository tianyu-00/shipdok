// Making a backup: the files that go into it, the encryption, and what is left behind when it fails. A fake engine stands in for Docker (it writes a
// pretend dump); the packing is done by the real tar, and the encryption by the real code.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_FILE_RE, BACKUP_MAGIC, decryptBackupFile } from '@shipdok/shared';
import { DUMP_COMMAND, LIST_COMMAND, makeBackup, removeBackupFiles } from '../src/backup.js';

const ID = '12345678-aaaa-4bbb-8ccc-1234567890ab';
const NOW = new Date('2026-10-22T03:04:05Z');
const DUMP = 'PGDMP-pretend-dump-with-a-recognisable-row: tianyu';
const SECRET = 'the-encryption-key-do-not-leak-0123456789';
let dir; let secretsDir;

const engine = (over = {}) => {
  const calls = { dump: [], list: [] };
  return {
    calls,
    findPostgresContainer: async () => 'shipdok-postgres-1',
    execToFile: async (container, command, file) => { calls.dump.push({ container, command }); await writeFile(file, DUMP); },
    execWithFile: async (container, command, file) => { calls.list.push({ container, command, bytes: (await readFile(file)).length }); return '; Archive created\n1; 1262 db\n'; },
    ...over,
  };
};
const make = (o = {}) => makeBackup({ id: ID, trigger: 'manual', dir, secretsDir, version: '0.1.17', eng: engine(), now: NOW, ...o });
const names = async () => (await readdir(dir)).sort();
const extract = async (file) => { const out = await mkdtemp(join(tmpdir(), 'bk-x-')); execFileSync('tar', ['xf', file, '-C', out]); return out; };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bk-dir-'));
  secretsDir = await mkdtemp(join(tmpdir(), 'bk-sec-'));
  await writeFile(join(secretsDir, 'app_secrets_key'), SECRET);
  await writeFile(join(secretsDir, 'postgres_password'), 'pg-pass');
});

describe('a plain backup', () => {
  test('is one file with a name of ours, and nothing else is left in the folder', async () => {
    const r = await make();
    assert.match(r.filename, BACKUP_FILE_RE);
    assert.equal(r.filename, 'shipdok-backup-20261022-030405-12345678.tar');
    assert.deepEqual(await names(), [r.filename], 'no temporary folder remains');
    assert.deepEqual([r.encrypted, r.verified, r.version, r.warning], [false, true, '0.1.17', null]);
    assert.equal(r.sizeBytes, (await stat(join(dir, r.filename))).size);
  });
  test('holds the dump, the secrets and a manifest', async () => {
    const r = await make({ lastMigration: async () => '030_backups.sql' });
    const x = await extract(join(dir, r.filename));
    assert.deepEqual((await readdir(x)).sort(), ['db.dump', 'manifest.json', 'secrets.tgz']);
    assert.equal(await readFile(join(x, 'db.dump'), 'utf8'), DUMP);
    const manifest = JSON.parse(await readFile(join(x, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, { format: 1, createdAt: '2026-10-22T03:04:05.000Z', shipdokVersion: '0.1.17', trigger: 'manual', lastMigration: '030_backups.sql', includesSecrets: true, files: ['db.dump', 'secrets.tgz', 'manifest.json'] });
    const s = await mkdtemp(join(tmpdir(), 'bk-s-'));
    execFileSync('tar', ['xzf', join(x, 'secrets.tgz'), '-C', s]);
    assert.equal(await readFile(join(s, 'app_secrets_key'), 'utf8'), SECRET);
    assert.equal(await readFile(join(s, 'postgres_password'), 'utf8'), 'pg-pass');
  });
  test('is readable by its owner only', async () => {
    const r = await make();
    assert.equal((await stat(join(dir, r.filename))).mode & 0o077, 0);
  });
  test('the dump is made by the container\'s own pg_dump with its own environment, then read back', async () => {
    const eng = engine();
    await make({ eng });
    assert.deepEqual(eng.calls.dump, [{ container: 'shipdok-postgres-1', command: DUMP_COMMAND }]);
    assert.match(DUMP_COMMAND.join(' '), /pg_dump -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" --format=custom/);
    assert.ok(!DUMP_COMMAND.join(' ').includes('PASSWORD'), 'no password is passed');
    assert.deepEqual(eng.calls.list, [{ container: 'shipdok-postgres-1', command: LIST_COMMAND, bytes: DUMP.length }]);
  });
  test('creates the folder when it does not exist yet', async () => {
    const r = await make({ dir: join(dir, 'new', 'folder') });
    assert.deepEqual(await readdir(join(dir, 'new', 'folder')), [r.filename]);
  });
  test('without the secrets folder the backup is made but says so, and holds no secrets', async () => {
    const r = await make({ secretsDir: join(tmpdir(), 'bk-no-such-secrets') });
    assert.match(r.warning, /secrets could not be included/);
    const x = await extract(join(dir, r.filename));
    assert.deepEqual((await readdir(x)).sort(), ['db.dump', 'manifest.json']);
    assert.equal(JSON.parse(await readFile(join(x, 'manifest.json'), 'utf8')).includesSecrets, false);
  });
  test('an empty secrets folder counts as none', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'bk-empty-'));
    assert.match((await make({ secretsDir: empty })).warning, /secrets/);
  });
});

describe('an encrypted backup', () => {
  const PASS = 'correct horse battery staple';
  test('has the .enc name, the magic, none of the content in clear, and opens only with the passphrase', async () => {
    const r = await make({ passphrase: PASS });
    assert.equal(r.filename, 'shipdok-backup-20261022-030405-12345678.tar.enc');
    assert.equal(r.encrypted, true);
    const raw = await readFile(join(dir, r.filename));
    assert.ok(raw.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC));
    for (const text of [DUMP, 'db.dump', 'manifest', SECRET]) assert.ok(!raw.includes(text), text);
    assert.deepEqual(await names(), [r.filename], 'the plain bundle is not left behind');
    const plain = join(dir, 'opened.tar');
    await assert.rejects(decryptBackupFile(join(dir, r.filename), plain, 'not the passphrase'), /Could not open/);
    await decryptBackupFile(join(dir, r.filename), plain, PASS);
    const x = await extract(plain);
    assert.equal(await readFile(join(x, 'db.dump'), 'utf8'), DUMP);
  });
  test('a passphrase that cannot be used fails the backup and leaves nothing', async () => {
    await assert.rejects(make({ passphrase: 'short' }), /at least 12/);
    assert.deepEqual(await names(), []);
  });
  test('an empty passphrase means plain (it is only ever null or a real one)', async () => {
    assert.equal((await make({ passphrase: '' })).encrypted, false);
  });
});

describe('when it fails', () => {
  const cases = [
    ['no Postgres container is found', { findPostgresContainer: async () => { throw new Error('Could not find the Postgres container'); } }, /Could not find the Postgres container/],
    ['the dump command fails', { execToFile: async () => { throw new Error('pg_dump failed: connection refused'); } }, /pg_dump failed: connection refused/],
    ['the dump is empty', { execToFile: async (c, cmd, file) => { await writeFile(file, ''); } }, /dump is empty/],
    ['the dump cannot be read back', { execWithFile: async () => { throw new Error('pg_restore failed: not a valid archive'); } }, /not a valid archive/],
    ['the read-back lists nothing', { execWithFile: async () => '  \n' }, /could not be read back/],
  ];
  for (const [name, over, message] of cases) {
    test(`${name}: the reason is given, and no file or temporary folder is left`, async () => {
      await assert.rejects(make({ eng: engine(over) }), message);
      assert.deepEqual(await names(), []);
    });
  }
  test('a failed backup does not touch the ones already there', async () => {
    const ok = await make();
    await assert.rejects(make({ id: '99999999-aaaa-4bbb-8ccc-1234567890ab', eng: engine({ execToFile: async () => { throw new Error('boom'); } }) }), /boom/);
    assert.deepEqual(await names(), [ok.filename]);
  });
  test('the error never contains the secrets', async () => {
    try { await make({ eng: engine({ execToFile: async () => { throw new Error('pg_dump failed'); } }) }); } catch (e) { assert.ok(!e.message.includes(SECRET)); }
  });
});

describe('removing the files of backups', () => {
  test('removes the files named, ignores a missing one and anything that is not one of ours', async () => {
    const a = await make();
    await writeFile(join(dir, 'keep-me.txt'), 'x');
    await mkdir(join(dir, 'sub'));
    await removeBackupFiles(dir, [a.filename, 'shipdok-backup-20200101-000000-aaaaaaaa.tar', 'keep-me.txt', '../outside', 'sub']);
    assert.deepEqual(await names(), ['keep-me.txt', 'sub']);
  });
});
