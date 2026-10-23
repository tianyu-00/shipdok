// The backup requests and the schedule, against the real (test) database; the dump itself is a fake.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptSecret } from '@shipdok/shared';
import * as db from '../src/db.js';
import { answerBackup, createBackupRunner, loadPassphrase, prune, requestIfDue, PASSPHRASE_CONTEXT } from '../src/backuprunner.js';
import { KEY, OTHER_KEY, ready, pool } from './helpers.js';

const PASS = 'correct horse battery staple';
let dir; let secretsDir; let logs;
const log = (m) => logs.push(m);
const engine = (over = {}) => ({
  findPostgresContainer: async () => 'pg',
  execToFile: async (c, cmd, file) => writeFile(file, 'pretend dump'),
  execWithFile: async () => '1; 1262 db\n',
  ...over,
});
const answer = (request, o = {}) => answerBackup(request, { db, eng: engine(), secretsKey: KEY, dir, secretsDir, version: '0.1.17', log, ...o });
const rowOf = async (id) => (await pool.query('SELECT * FROM backups WHERE id = $1', [id])).rows[0];
const files = async () => (await readdir(dir)).sort();
const putSetting = (key, value, at = null) => pool.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, COALESCE($3, now())) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = COALESCE($3, now())`, [key, JSON.stringify(value), at]);
// A finished backup row (and its file) as it would be left by an earlier run
let n = 0;
const oldBackup = async (status, ageMinutes) => {
  n += 1;
  const name = status === 'ok' ? `shipdok-backup-20260101-0000${String(n).padStart(2, '0')}-${String(n).padStart(8, '0')}.tar` : null;
  if (name) await writeFile(join(dir, name), 'x');
  const { rows } = await pool.query(
    `INSERT INTO backups (status, trigger, filename, requested_at, finished_at) VALUES ($1, 'manual', $2, now() - make_interval(mins => $3), now() - make_interval(mins => $3)) RETURNING id`, [status, name, ageMinutes]);
  return { id: rows[0].id, name };
};

before(ready);
beforeEach(async () => {
  await pool.query('TRUNCATE volume_restores, backups');
  await pool.query(`DELETE FROM settings WHERE key IN ('backup_schedule', 'backup_passphrase')`);
  dir = await mkdtemp(join(tmpdir(), 'bkr-dir-'));
  secretsDir = await mkdtemp(join(tmpdir(), 'bkr-sec-'));
  await writeFile(join(secretsDir, 'app_secrets_key'), 'k');
  logs = [];
});

describe('asking for a backup', () => {
  test('is recorded as queued, and only one may wait or run at a time', async () => {
    const id = await db.requestBackup('manual');
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal((await rowOf(id)).status, 'queued');
    assert.equal(await db.requestBackup('scheduled'), null);
    await pool.query(`UPDATE backups SET status = 'running'`);
    assert.equal(await db.requestBackup('manual'), null, 'a running one blocks too');
    await pool.query(`UPDATE backups SET status = 'ok', filename = NULL`);
    assert.ok(await db.requestBackup('manual'), 'a finished one does not');
  });
  test('the waiting request is taken and marked running', async () => {
    const first = await db.requestBackup('manual');
    await pool.query(`UPDATE backups SET status = 'failed' WHERE id = $1`, [first]);
    const second = await db.requestBackup('scheduled');
    const claimed = await db.claimQueuedBackup();
    assert.deepEqual([claimed.id, claimed.trigger], [second, 'scheduled']);
    assert.equal((await rowOf(second)).status, 'running');
    assert.equal(await db.claimQueuedBackup(), null);
  });
  test('a backup that was running when the worker stopped is marked failed, and a new one can be asked for', async () => {
    const id = await db.requestBackup('manual');
    await db.claimQueuedBackup();
    await db.interruptRunningBackups();
    const row = await rowOf(id);
    assert.deepEqual([row.status, row.error], ['failed', 'Interrupted: the worker stopped while it was running']);
    assert.ok(await db.requestBackup('manual'));
  });
});

describe('answering a request', () => {
  test('makes the file and records how it went', async () => {
    const id = await db.requestBackup('manual');
    const request = await db.claimQueuedBackup();
    const r = await answer(request);
    assert.equal(r.ok, true);
    const row = await rowOf(id);
    assert.deepEqual([row.status, row.encrypted, row.verified, row.version, row.error, row.warning], ['ok', false, true, '0.1.17', null, null]);
    assert.deepEqual(await files(), [row.filename]);
    assert.equal(Number(row.size_bytes), (await stat(join(dir, row.filename))).size);
    assert.ok(row.finished_at);
  });
  test('a failure is recorded with its reason and leaves no file', async () => {
    const id = await db.requestBackup('manual');
    const r = await answer(await db.claimQueuedBackup(), { eng: engine({ execToFile: async () => { throw new Error('pg_dump failed: no connection'); } }) });
    assert.equal(r.ok, false);
    const row = await rowOf(id);
    assert.deepEqual([row.status, row.error, row.filename], ['failed', 'pg_dump failed: no connection', null]);
    assert.deepEqual(await files(), []);
    assert.ok(logs.some((m) => /failed: pg_dump failed/.test(m)));
  });
  test('a warning (no secrets folder) is recorded and the backup still counts as made', async () => {
    const id = await db.requestBackup('manual');
    await answer(await db.claimQueuedBackup(), { secretsDir: join(tmpdir(), 'bkr-none') });
    const row = await rowOf(id);
    assert.equal(row.status, 'ok');
    assert.match(row.warning, /secrets could not be included/);
  });
  test('with a passphrase set, the backup is encrypted', async () => {
    await putSetting('backup_passphrase', encryptSecret(PASS, KEY, PASSPHRASE_CONTEXT));
    const id = await db.requestBackup('manual');
    await answer(await db.claimQueuedBackup());
    const row = await rowOf(id);
    assert.deepEqual([row.encrypted, row.filename.endsWith('.tar.enc')], [true, true]);
  });
  test('with a passphrase that cannot be read, NO plain backup is made instead', async () => {
    await putSetting('backup_passphrase', encryptSecret(PASS, OTHER_KEY, PASSPHRASE_CONTEXT)); // stored under another platform key
    const id = await db.requestBackup('manual');
    await answer(await db.claimQueuedBackup());
    const row = await rowOf(id);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /passphrase could not be read/);
    assert.deepEqual(await files(), []);
  });
  test('the passphrase is bound to its purpose: one stored for something else does not open', async () => {
    await putSetting('backup_passphrase', encryptSecret(PASS, KEY, 'env:something:else'));
    await assert.rejects(loadPassphrase({ db, secretsKey: KEY }));
    await putSetting('backup_passphrase', encryptSecret(PASS, KEY, PASSPHRASE_CONTEXT));
    assert.equal(await loadPassphrase({ db, secretsKey: KEY }), PASS);
    await pool.query(`DELETE FROM settings WHERE key = 'backup_passphrase'`);
    assert.equal(await loadPassphrase({ db, secretsKey: KEY }), null);
  });
  test('the manifest knows the last migration', async () => {
    const id = await db.requestBackup('manual');
    await answer(await db.claimQueuedBackup());
    assert.equal(await db.lastMigrationName(), (await pool.query('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')).rows[0].name);
    assert.ok((await rowOf(id)).filename);
  });
});

describe('keeping only the newest', () => {
  test('keeps the number set, removes the older files and rows, and the newest are the ones that stay', async () => {
    await putSetting('backup_schedule', { frequency: 'daily', hour: 3, weekday: 1, keep: 2 });
    const a = await oldBackup('ok', 40); const b = await oldBackup('ok', 30); const c = await oldBackup('ok', 20); const d = await oldBackup('ok', 10);
    assert.equal(await prune({ db, dir, log }), 2);
    assert.deepEqual((await pool.query('SELECT id FROM backups ORDER BY requested_at')).rows.map((r) => r.id), [c.id, d.id]);
    assert.deepEqual(await files(), [c.name, d.name].sort());
    assert.ok(!(await files()).some((f) => [a.name, b.name].includes(f)), 'the two oldest files are gone');
  });
  test('the default is to keep 7', async () => {
    for (let i = 0; i < 9; i += 1) await oldBackup('ok', 100 - i);
    assert.equal(await prune({ db, dir, log }), 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM backups')).rows[0].n, 7);
  });
  test('failed ones do not count against the good ones, and only the newest 10 of them are kept', async () => {
    await putSetting('backup_schedule', { frequency: 'daily', hour: 3, weekday: 1, keep: 1 });
    const good = await oldBackup('ok', 5);
    for (let i = 0; i < 12; i += 1) await oldBackup('failed', 100 - i);
    assert.equal(await prune({ db, dir, log }), 2);
    const rows = (await pool.query('SELECT status FROM backups')).rows.map((r) => r.status);
    assert.deepEqual([rows.filter((s) => s === 'ok').length, rows.filter((s) => s === 'failed').length], [1, 10]);
    assert.deepEqual(await files(), [good.name]);
  });
  test('a backup that is queued or running is never removed', async () => {
    await putSetting('backup_schedule', { frequency: 'daily', hour: 3, weekday: 1, keep: 1 });
    await oldBackup('ok', 50); await oldBackup('ok', 40);
    const waiting = await db.requestBackup('manual');
    await prune({ db, dir, log });
    assert.equal((await rowOf(waiting)).status, 'queued');
  });
  test('a finished backup prunes right after itself', async () => {
    await putSetting('backup_schedule', { frequency: 'daily', hour: 3, weekday: 1, keep: 1 });
    await oldBackup('ok', 50);
    await db.requestBackup('manual');
    await answer(await db.claimQueuedBackup());
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM backups WHERE status = 'ok'`)).rows[0].n, 1);
    assert.equal((await files()).length, 1);
  });
});

describe('the schedule', () => {
  const noon = Date.parse('2026-10-22T12:00:00Z');
  test('asks for a scheduled backup when one is due (the default: daily at 03:00 UTC)', async () => {
    assert.equal(await requestIfDue({ db, now: noon, log }), true);
    const row = (await pool.query('SELECT * FROM backups')).rows[0];
    assert.deepEqual([row.status, row.trigger], ['queued', 'scheduled']);
  });
  test('not twice: while one is waiting, and not again once it ran', async () => {
    assert.equal(await requestIfDue({ db, now: noon, log }), true);
    assert.equal(await requestIfDue({ db, now: noon, log }), false);
    await answer(await db.claimQueuedBackup());
    assert.equal(await requestIfDue({ db, now: noon + 60_000, log }), false);
    assert.equal(await requestIfDue({ db, now: Date.parse('2026-10-23T03:00:30Z'), log }), true, 'the next day\'s slot');
  });
  test('not when it is off', async () => {
    await putSetting('backup_schedule', { frequency: 'off', hour: 3, weekday: 1, keep: 7 });
    assert.equal(await requestIfDue({ db, now: noon, log }), false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM backups')).rows[0].n, 0);
  });
  test('not for a slot that passed before the schedule was changed', async () => {
    await putSetting('backup_schedule', { frequency: 'daily', hour: 3, weekday: 1, keep: 7 }, new Date('2026-10-22T08:00:00Z'));
    assert.equal(await requestIfDue({ db, now: noon, log }), false);
    assert.equal(await requestIfDue({ db, now: Date.parse('2026-10-23T03:00:01Z'), log }), true);
  });
  test('a manual backup since the slot is enough', async () => {
    await pool.query(`INSERT INTO backups (status, trigger, filename, started_at, finished_at) VALUES ('ok', 'manual', NULL, '2026-10-22T09:00:00Z', '2026-10-22T09:00:10Z')`);
    assert.equal(await requestIfDue({ db, now: noon, log }), false);
  });
  test('weekly waits for its day', async () => {
    await putSetting('backup_schedule', { frequency: 'weekly', hour: 3, weekday: 1, keep: 7 }, new Date('2026-10-01T00:00:00Z'));
    await pool.query(`INSERT INTO backups (status, trigger, started_at, finished_at) VALUES ('ok', 'scheduled', '2026-10-19T03:00:05Z', '2026-10-19T03:00:09Z')`);
    assert.equal(await requestIfDue({ db, now: noon, log }), false, 'done on Monday');
    assert.equal(await requestIfDue({ db, now: Date.parse('2026-10-26T03:00:10Z'), log }), true, 'next Monday');
  });
});

describe('the runner', () => {
  test('one tick answers a waiting request', async () => {
    const id = await db.requestBackup('manual');
    const runner = createBackupRunner({ db, eng: engine(), secretsKey: KEY, dir, secretsDir, version: '0.1.17', log, scheduleEveryMs: 1e12 });
    assert.equal(await runner.tick(), true);
    assert.equal((await rowOf(id)).status, 'ok');
    assert.equal(await runner.tick(), false, 'nothing more waiting');
  });
  test('a tick also asks for a scheduled backup that is due, and answers it', async () => {
    await putSetting('backup_schedule', { frequency: 'daily', hour: 0, weekday: 1, keep: 7 }, new Date('2020-01-01T00:00:00Z'));
    const runner = createBackupRunner({ db, eng: engine(), secretsKey: KEY, dir, secretsDir, log, scheduleEveryMs: 0 });
    assert.equal(await runner.tick(), true);
    const rows = (await pool.query('SELECT status, trigger FROM backups')).rows;
    assert.deepEqual(rows, [{ status: 'ok', trigger: 'scheduled' }]);
  });
  test('start marks an interrupted backup failed, and stop ends the loop', async () => {
    await db.requestBackup('manual');
    await db.claimQueuedBackup();
    const runner = createBackupRunner({ db, eng: engine(), secretsKey: KEY, dir, secretsDir, log, intervalMs: 20, scheduleEveryMs: 1e12 });
    runner.start();
    await new Promise((r) => setTimeout(r, 150));
    await runner.stop();
    assert.equal((await pool.query(`SELECT status FROM backups`)).rows[0].status, 'failed');
  });
});
