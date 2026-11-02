// The restore as the worker answers it: the checks, stopping the app, the safety backup, the passphrase, the record. The real test database; a fake Docker
// (the volumes are folders); the backup files are made by the real makeVolumeBackup.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptSecret, restorePassphraseContext } from '@shipdok/shared';
import * as db from '../src/db.js';
import { answerRestore, createBackupRunner, recoverAfterStop, PASSPHRASE_CONTEXT } from '../src/backuprunner.js';
import { makeVolumeBackup } from '../src/volumebackup.js';
import { createActivity } from '../src/activity.js';
import { fakeEngine } from './fake-engine.js';
import { KEY, ready, reset, makeApp, pool } from './helpers.js';

const GB = 1024 ** 3;
const PASS = 'correct horse battery staple';
let dir; let vols; let srcData; let logs; let appId; let appName;
const log = (m) => logs.push(m);
const restoreRow = async (id) => (await pool.query('SELECT * FROM volume_restores WHERE id = $1', [id])).rows[0];
const backupRow = async (id) => (await pool.query('SELECT * FROM backups WHERE id = $1', [id])).rows[0];
const setApp = (id, f) => pool.query(`UPDATE apps SET ${Object.keys(f).map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...Object.values(f)]);
const putSetting = (key, value) => pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [key, JSON.stringify(value)]);
const tree = async (d) => (await readdir(d)).sort();
const read = (d, f) => readFile(join(d, f), 'utf8');

// Fake Docker: stop/start from fakeEngine; the backup helper and the restore helper both work on the folders in `vols`.
const engine = (over = {}) => {
  const base = fakeEngine({ previous: ['live-1'] });
  base.ensured = [];
  const note = (e) => base.events.push(e);
  return Object.assign(base, {
    appImage: async () => 'sha256:app', ownImage: async () => 'sha256:worker',
    volumeSizes: async () => new Map(), diskSpace: async () => ({ totalBytes: 100 * GB, freeBytes: 90 * GB }),
    createBackupHelper: async ({ volumes: names }) => { note('safety helper'); return { names, remove: async () => {} }; },
    archiveVolume: async (h, i, file, mount) => { note(mount ? `read back ${i}` : `copy ${i}`); execFileSync('tar', ['cf', file, '-C', vols[h.names[i]], '.']); },
    createRestoreHelper: async ({ volumes: names, script }) => ({ names, script, remove: async () => { note('restore helper removed'); } }),
    runRestoreScript: async (h) => {
      note('script');
      const dirs = h.names.map((n) => vols[n]);
      try { return { code: 0, output: execFileSync('sh', ['-c', h.script.replace('/vrestore/*', dirs.join(' '))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (err) { return { code: err.status, output: String(err.stdout) }; }
    },
    ensureVolume: async ({ name, labels }) => { note(`ensure ${name}`); base.ensured.push({ name, labels }); vols[name] ??= await mkdtemp(join(tmpdir(), 'rr-new-')); },
    putVolumeArchive: async (h, i, file) => { note(`write ${i}`); execFileSync('tar', ['xf', file, '-C', vols[h.names[i]]]); },
    removeStaleHelpers: async () => 0,
  }, over);
};
const orderOf = (eng) => eng.events.filter((e) => /^(stop|start|safety|copy|script|write|read back|restore helper)/.test(e));

// A backup of the app (one volume, /data) made now, as a file and a row; returns its id
async function aBackup({ passphrase = null, kind = 'volumes', status = 'ok' } = {}) {
  const id = (await pool.query(`INSERT INTO backups (kind, app_id, app_name, status, trigger, started_at) VALUES ($1, $2, $3, 'running', 'manual', now()) RETURNING id`, [kind, kind === 'volumes' ? appId : null, kind === 'volumes' ? appName : null])).rows[0].id;
  const eng = { appImage: async () => 'img', volumeSizes: async () => new Map(), diskSpace: async () => ({ totalBytes: 100 * GB, freeBytes: 90 * GB }), createBackupHelper: async () => ({ remove: async () => {} }), archiveVolume: async (h, i, file) => execFileSync('tar', ['cf', file, '-C', srcData, '.']) };
  const made = await makeVolumeBackup({ id, trigger: 'manual', dir, app: { id: appId, name: appName, slug: 'a' }, volumes: [{ container_path: '/data', docker_name: 'vol-data' }], passphrase, eng });
  await db.markBackupOk(id, made);
  if (status !== 'ok') await pool.query(`UPDATE backups SET status = $2 WHERE id = $1`, [id, status]);
  return id;
}
const ask = async (backupId, o = {}) => {
  const { rows } = await pool.query(
    `INSERT INTO volume_restores (backup_id, app_id, app_name, mode, safety_backup, passphrase_enc, reclaim, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'running') RETURNING *`,
    [backupId, o.appId === undefined ? appId : o.appId, o.appName ?? appName, o.mode ?? 'replace', o.safety ?? true, o.passphraseEnc ?? null, o.reclaim ?? false]);
  return rows[0];
};
const answer = async (row, o = {}) => { const eng = o.eng ?? engine(); const r = await answerRestore(row, { db, secretsKey: KEY, dir, version: '0.1.20', log, ...o, eng }); return { r, eng }; };
const runtime = (state) => db.setRuntime(appId, { state, action: 'start' });

before(ready);
after(() => pool.end());
beforeEach(async () => {
  await reset();
  await pool.query('TRUNCATE volume_restores, backups, app_volumes');
  await pool.query(`DELETE FROM settings WHERE key IN ('backup_schedule', 'backup_passphrase')`);
  dir = await mkdtemp(join(tmpdir(), 'rr-dir-'));
  vols = { 'vol-data': await mkdtemp(join(tmpdir(), 'rr-v-')) };
  srcData = await mkdtemp(join(tmpdir(), 'rr-src-'));
  await writeFile(join(srcData, 'a.txt'), 'from the backup');
  await writeFile(join(vols['vol-data'], 'a.txt'), 'CURRENT');
  await writeFile(join(vols['vol-data'], 'stale.txt'), 'stale');
  logs = [];
  appId = await makeApp();
  appName = (await pool.query('SELECT name FROM apps WHERE id = $1', [appId])).rows[0].name;
  await pool.query(`INSERT INTO app_volumes (app_id, app_name, container_path, docker_name) VALUES ($1, 'A', '/data', 'vol-data')`, [appId]);
  await setApp(appId, { desired_state: 'running' });
  await runtime('running');
});

describe('a restore of a running app', () => {
  test('stops it, makes the safety backup, restores, reads back, starts it: in that order, and records it', async () => {
    const backup = await aBackup();
    const row = await ask(backup);
    const { r, eng } = await answer(row);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(orderOf(eng), ['stop live-1', 'safety helper', 'copy 0', 'script', 'write 0', 'read back 0', 'restore helper removed', 'start live-1']);
    assert.deepEqual(await tree(vols['vol-data']), ['a.txt']);
    assert.equal(await read(vols['vol-data'], 'a.txt'), 'from the backup');
    const done = await restoreRow(row.id);
    assert.deepEqual([done.status, done.volume_count, done.error, done.passphrase_enc, !!done.finished_at], ['ok', 1, null, null, true]);
    assert.equal((await pool.query('SELECT state FROM app_runtime WHERE app_id = $1', [appId])).rows[0].state, 'running');
  });
  test('the safety backup is in the list, made from the data as it was, with its own trigger, and the restore says which it is', async () => {
    const backup = await aBackup();
    const row = await ask(backup);
    await answer(row);
    const done = await restoreRow(row.id);
    const safety = await backupRow(done.safety_backup_id);
    assert.deepEqual([safety.kind, safety.trigger, safety.status, safety.app_id, safety.volume_count, safety.verified], ['volumes', 'before_restore', 'ok', appId, 1, true]);
    // its content is the OLD data
    const out = await mkdtemp(join(tmpdir(), 'rr-o-'));
    execFileSync('tar', ['xf', join(dir, safety.filename), '-C', out]);
    const inner = await mkdtemp(join(tmpdir(), 'rr-i-'));
    execFileSync('tar', ['xf', join(out, 'volume-0.tar'), '-C', inner]);
    assert.deepEqual((await tree(inner)), ['a.txt', 'stale.txt']);
    assert.equal(await read(inner, 'a.txt'), 'CURRENT');
    assert.equal(JSON.parse(await read(out, 'manifest.json')).appWasStopped, true, 'the app was stopped for it');
  });
  test('without the safety backup none is made', async () => {
    const row = await ask(await aBackup(), { safety: false });
    const { eng } = await answer(row);
    assert.ok(!orderOf(eng).includes('safety helper'));
    assert.equal((await restoreRow(row.id)).safety_backup_id, null);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM backups WHERE trigger = 'before_restore'`)).rows[0].n, 0);
  });
  test('the safety backup is encrypted with the current passphrase when there is one', async () => {
    await putSetting('backup_passphrase', encryptSecret(PASS, KEY, PASSPHRASE_CONTEXT));
    const row = await ask(await aBackup());
    await answer(row);
    const safety = await backupRow((await restoreRow(row.id)).safety_backup_id);
    assert.deepEqual([safety.encrypted, safety.filename.endsWith('.enc')], [true, true]);
  });
  test('if the safety backup fails NOTHING is restored, the app is started again and the failure is on both records', async () => {
    const row = await ask(await aBackup());
    const eng = engine({ createBackupHelper: async () => { throw new Error('docker: no such image'); } });
    const { r } = await answer(row, { eng });
    assert.equal(r.ok, false);
    assert.match(r.error, /backup of the current data failed, so nothing was restored: docker: no such image/);
    assert.deepEqual(await tree(vols['vol-data']), ['a.txt', 'stale.txt']);
    assert.equal(await read(vols['vol-data'], 'a.txt'), 'CURRENT');
    assert.deepEqual(orderOf(eng), ['stop live-1', 'start live-1']);
    const safety = await backupRow((await restoreRow(row.id)).safety_backup_id);
    assert.equal(safety.status, 'failed');
    assert.equal((await restoreRow(row.id)).status, 'failed');
  });
  test('a failure while writing says the files may be partly restored and points at the safety backup; the app is still started', async () => {
    const row = await ask(await aBackup());
    const eng = engine({ putVolumeArchive: async () => { throw new Error('docker: disk full'); } });
    const { r } = await answer(row, { eng });
    assert.match(r.error, /disk full\. The files of the app may be only partly restored: the backup made just before is in the list/);
    assert.deepEqual(orderOf(eng).slice(-2), ['restore helper removed', 'start live-1']);
  });
  test('the partial warning says nothing about a safety backup when none was made', async () => {
    const row = await ask(await aBackup(), { safety: false });
    const { r } = await answer(row, { eng: engine({ putVolumeArchive: async () => { throw new Error('boom'); } }) });
    assert.match(r.error, /may be only partly restored$/);
  });
  test('the app is stopped only after the checks: a path it no longer has is refused with the app never stopped', async () => {
    const row = await ask(await aBackup());
    await pool.query('DELETE FROM app_volumes');
    await pool.query(`INSERT INTO app_volumes (app_id, app_name, container_path, docker_name) VALUES ($1, 'A', '/elsewhere', 'vol-else')`, [appId]);
    const { r, eng } = await answer(row);
    assert.match(r.error, /no persistent storage at \/data any more/);
    assert.deepEqual(orderOf(eng), []);
  });
  test('an app that did not start again is a warning on the restore, and is added to an error', async () => {
    const eng = engine({ startContainer: async () => { throw new Error('port in use'); } });
    const row = await ask(await aBackup());
    await answer(row, { eng });
    const done = await restoreRow(row.id);
    assert.equal(done.status, 'ok');
    assert.match(done.warning, /could not be started again after the restore: port in use/);
  });
  test('the monitor is told to leave the app alone from the stop until the start', async () => {
    const activity = createActivity();
    const seen = [];
    const eng = engine({ putVolumeArchive: async (h, i, file) => { seen.push(activity.isBusy(appId)); execFileSync('tar', ['xf', file, '-C', vols[h.names[i]]]); } });
    await answer(await ask(await aBackup()), { eng, activity });
    assert.deepEqual(seen, [true]);
    assert.equal(activity.isBusy(appId), false);
  });
  test('a deployment or another job working on the app means it is not stopped and nothing is restored', async () => {
    const activity = createActivity();
    const row = await ask(await aBackup());
    let out;
    await activity.run(appId, async () => { out = await answer(row, { activity }); });
    assert.match(out.r.error, /working on this app right now/);
    assert.equal(await read(vols['vol-data'], 'a.txt'), 'CURRENT');
    assert.deepEqual(orderOf(out.eng), []);
  });
});

describe('a reclaim into another app', () => {
  let other;
  const inUse = async (id) => (await pool.query(`SELECT container_path, docker_name, state FROM app_volumes WHERE app_id = $1 ORDER BY container_path`, [id])).rows;
  beforeEach(async () => { other = await makeApp(); await setApp(other, { desired_state: 'running' }); await db.setRuntime(other, { state: 'running', action: 'start' }); });
  const reclaim = async (o = {}) => { const backup = o.backup ?? await aBackup(); const row = await ask(backup, { appId: other, appName: 'Other app', reclaim: true, ...o }); const out = await answer(row, o); return { row, ...out }; };

  test('into an app with no storage: the path is added with a new labelled volume, the files go in, nothing is stopped and no safety backup is made', async () => {
    const { row, r, eng } = await reclaim();
    assert.equal(r.ok, true, r.error);
    const rows = await inUse(other);
    assert.deepEqual(rows.map((x) => [x.container_path, x.state]), [['/data', 'in_use']]);
    assert.match(rows[0].docker_name, /^shipdok-vol-[0-9a-f-]{36}$/);
    assert.deepEqual(eng.ensured, [{ name: rows[0].docker_name, labels: { 'shipdok.managed': 'true', 'shipdok.app-id': other } }]);
    assert.equal(await read(vols[rows[0].docker_name], 'a.txt'), 'from the backup');
    assert.ok(!orderOf(eng).some((e) => /^(stop|start|safety)/.test(e)), 'the running app does not use the new volume yet');
    assert.equal((await restoreRow(row.id)).safety_backup_id, null);
    assert.equal(await read(vols['vol-data'], 'a.txt'), 'CURRENT', 'the volume of the backup\'s own app is not touched');
  });
  test('the restore says which paths were added and that the app must be deployed', async () => {
    const { row } = await reclaim();
    const done = await restoreRow(row.id);
    assert.equal(done.status, 'ok');
    assert.equal(done.warning, 'Added the storage path /data to the app: deploy it to mount it');
  });
  test('the app that receives it is the one the row names (the backup stays the other app\'s)', async () => {
    const { row } = await reclaim();
    const done = await restoreRow(row.id);
    assert.deepEqual([done.app_id, done.app_name, done.reclaim], [other, 'Other app', true]);
  });
  test('into an app that already has the path: the same as a restore (stop, safety copy, replace), and no path is added', async () => {
    await pool.query(`INSERT INTO app_volumes (app_id, app_name, container_path, docker_name) VALUES ($1, 'x', '/data', 'vol-otherdata')`, [other]);
    vols['vol-otherdata'] = await mkdtemp(join(tmpdir(), 'rr-od-'));
    await writeFile(join(vols['vol-otherdata'], 'old.txt'), 'old');
    const { row, r, eng } = await reclaim();
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(orderOf(eng).slice(0, 2), ['stop live-1', 'safety helper']);
    assert.deepEqual(await tree(vols['vol-otherdata']), ['a.txt']);
    assert.equal((await inUse(other)).length, 1);
    assert.equal((await restoreRow(row.id)).warning, null);
    assert.ok((await restoreRow(row.id)).safety_backup_id);
  });
  test('a path the app has taken meanwhile fails it before anything is written, and says so', async () => {
    const eng = engine({ ensureVolume: async () => { throw new Error('should not be reached'); } });
    await db.pool.query(`SELECT 1`);
    const backup = await aBackup();
    const row = await ask(backup, { appId: other, appName: 'Other app', reclaim: true });
    // the path appears between the checks and the provisioning
    const original = db.addAppVolumes;
    const racing = { ...db, addAppVolumes: async (id, v) => { await pool.query(`INSERT INTO app_volumes (app_id, app_name, container_path, docker_name) VALUES ($1, 'x', '/data', 'vol-race')`, [id]); return original(id, v); } };
    const { r } = await answer(row, { eng, db: racing });
    assert.equal(r.ok, false);
    assert.match(r.error, /taken in the meantime/);
    assert.equal((await inUse(other)).length, 1, 'only the one that was already there');
    assert.deepEqual(vols['vol-race'], undefined);
  });
  test('a restore that is NOT a reclaim into an app without storage is still refused', async () => {
    const row = await ask(await aBackup(), { appId: other, appName: 'Other app', reclaim: false });
    const { r } = await answer(row);
    assert.match(r.error, /no persistent storage any more/);
  });
  test('a backup path that clashes with the app\'s storage is refused with nothing added', async () => {
    await pool.query(`INSERT INTO app_volumes (app_id, app_name, container_path, docker_name) VALUES ($1, 'x', '/data/inner', 'vol-inner')`, [other]);
    const { r, eng } = await reclaim();
    assert.match(r.error, /\/data\/inner is inside \/data/);
    assert.equal((await inUse(other)).length, 1);
    assert.deepEqual(eng.ensured, []);
  });
  test('adding paths itself refuses an app that is gone or being deleted (the answer checks first, this is the last line against a race)', async () => {
    await setApp(other, { deleting_at: new Date() });
    await assert.rejects(db.addAppVolumes(other, [{ container_path: '/x', docker_name: 'shipdok-vol-x1' }]), /no longer exists or is being deleted/);
    await assert.rejects(db.addAppVolumes('11111111-1111-4111-8111-111111111111', [{ container_path: '/x', docker_name: 'shipdok-vol-x2' }]), /no longer exists/);
    assert.equal((await inUse(other)).length, 0);
  });
  test('adding several paths is all or nothing: one taken path adds none', async () => {
    await pool.query(`INSERT INTO app_volumes (app_id, app_name, container_path, docker_name) VALUES ($1, 'x', '/b', 'vol-b')`, [other]);
    await assert.rejects(db.addAppVolumes(other, [{ container_path: '/a', docker_name: 'shipdok-vol-a' }, { container_path: '/b', docker_name: 'shipdok-vol-b2' }]), /taken in the meantime/);
    assert.deepEqual((await inUse(other)).map((r) => r.container_path), ['/b']);
  });
  test('an app that is being deleted cannot receive one', async () => {
    await setApp(other, { deleting_at: new Date() });
    const { r } = await reclaim();
    assert.match(r.error, /being deleted/);
    assert.equal((await inUse(other)).length, 0);
  });
});

describe('an app that is not running', () => {
  test('is restored as it is and left stopped', async () => {
    await runtime('stopped');
    const row = await ask(await aBackup());
    const { r, eng } = await answer(row);
    assert.equal(r.ok, true, r.error);
    assert.ok(!orderOf(eng).some((e) => /^(stop|start)/.test(e)));
    const safety = await backupRow((await restoreRow(row.id)).safety_backup_id);
    const out = await mkdtemp(join(tmpdir(), 'rr-m-'));
    execFileSync('tar', ['xf', join(dir, safety.filename), '-C', out]);
    assert.equal(JSON.parse(await read(out, 'manifest.json')).appWasStopped, false, 'it was already stopped, not stopped for the copy');
    assert.equal(await read(vols['vol-data'], 'a.txt'), 'from the backup');
  });
  test('an app the administrator stops meanwhile is not started afterwards', async () => {
    const eng = engine({ putVolumeArchive: async (h, i, file) => { await setApp(appId, { desired_state: 'stopped' }); execFileSync('tar', ['xf', file, '-C', vols[h.names[i]]]); } });
    await answer(await ask(await aBackup()), { eng });
    assert.ok(!orderOf(eng).includes('start live-1'));
  });
});

describe('what it checks first', () => {
  const failsWith = async (row, pattern, o) => {
    const { r, eng } = await answer(row, o);
    assert.equal(r.ok, false);
    assert.match(r.error, pattern);
    assert.equal((await restoreRow(row.id)).status, 'failed');
    assert.deepEqual(orderOf(eng), [], 'nothing was touched');
    assert.equal(await read(vols['vol-data'], 'a.txt'), 'CURRENT');
  };
  test('the backup is gone from the list', async () => failsWith(await ask(null), /no longer exists/));
  test('the backup is not a finished backup of volumes', async () => {
    await failsWith(await ask(await aBackup({ status: 'failed' })), /gone from the backups folder/);
    await failsWith(await ask(await aBackup({ kind: 'platform' })), /gone from the backups folder/);
  });
  test('the file is gone from the folder', async () => {
    const id = await aBackup();
    await rm(join(dir, (await backupRow(id)).filename));
    await failsWith(await ask(id), /gone from the backups folder/);
  });
  test('the app is gone, or being deleted', async () => {
    await failsWith(await ask(await aBackup(), { appId: null }), /app no longer exists/);
    const row = await ask(await aBackup());
    await setApp(appId, { deleting_at: new Date() });
    await failsWith(row, /being deleted/);
  });
  test('the app has no storage any more', async () => {
    const row = await ask(await aBackup());
    await pool.query('DELETE FROM app_volumes');
    await failsWith(row, /no persistent storage any more/);
  });
});

describe('an encrypted backup', () => {
  test('opens with the current passphrase, with none given', async () => {
    await putSetting('backup_passphrase', encryptSecret(PASS, KEY, PASSPHRASE_CONTEXT));
    const { r } = await answer(await ask(await aBackup({ passphrase: PASS }), { safety: false }));
    assert.equal(r.ok, true, r.error);
  });
  test('opens with the passphrase given with the request (made with an older one), which is then removed from the row', async () => {
    await putSetting('backup_passphrase', encryptSecret('a newer passphrase of mine', KEY, PASSPHRASE_CONTEXT));
    const backup = await aBackup({ passphrase: PASS });
    const row = await ask(backup, { safety: false });
    await pool.query('UPDATE volume_restores SET passphrase_enc = $2 WHERE id = $1', [row.id, encryptSecret(PASS, KEY, restorePassphraseContext(row.id))]);
    const { r } = await answer((await pool.query('SELECT * FROM volume_restores WHERE id = $1', [row.id])).rows[0]);
    assert.equal(r.ok, true, r.error);
    assert.equal((await restoreRow(row.id)).passphrase_enc, null);
  });
  test('a given passphrase that is wrong fails with the file\'s usual vague message, and is removed from the row too', async () => {
    const backup = await aBackup({ passphrase: PASS });
    const row = await ask(backup);
    await pool.query('UPDATE volume_restores SET passphrase_enc = $2 WHERE id = $1', [row.id, encryptSecret('not the passphrase at all', KEY, restorePassphraseContext(row.id))]);
    const { r, eng } = await answer((await pool.query('SELECT * FROM volume_restores WHERE id = $1', [row.id])).rows[0]);
    assert.match(r.error, /wrong passphrase, or the file is damaged/);
    assert.equal((await restoreRow(row.id)).passphrase_enc, null);
    assert.equal(await read(vols['vol-data'], 'a.txt'), 'CURRENT');
    assert.deepEqual(orderOf(eng), []);
  });
  test('a passphrase stored for another restore is not read', async () => {
    const backup = await aBackup({ passphrase: PASS });
    const row = await ask(backup);
    await pool.query('UPDATE volume_restores SET passphrase_enc = $2 WHERE id = $1', [row.id, encryptSecret(PASS, KEY, restorePassphraseContext('11111111-1111-4111-8111-111111111111'))]);
    const { r } = await answer((await pool.query('SELECT * FROM volume_restores WHERE id = $1', [row.id])).rows[0]);
    assert.match(r.error, /could not be read/);
  });
  test('no passphrase set and none given says to give it', async () => {
    const { r } = await answer(await ask(await aBackup({ passphrase: PASS })));
    assert.match(r.error, /encrypted, but no passphrase is set/);
  });
});

describe('claiming and recording', () => {
  const queue = async (backupId, appIdArg = appId) => (await pool.query(
    `INSERT INTO volume_restores (backup_id, app_id, app_name, mode, safety_backup) VALUES ($1, $2, 'x', 'replace', true) RETURNING id`, [backupId, appIdArg])).rows[0].id;
  test('the oldest waiting restore is taken and marked running; there is none to take afterwards', async () => {
    const backup = await aBackup();
    const other = await makeApp();
    const second = await queue(backup, other);
    const first = await queue(backup);
    await pool.query(`UPDATE volume_restores SET requested_at = now() - interval '1 hour' WHERE id = $1`, [first]);
    const a = await db.claimQueuedRestore();
    assert.equal(a.id, first);
    assert.equal((await restoreRow(first)).status, 'running');
    assert.equal((await db.claimQueuedRestore()).id, second);
    assert.equal(await db.claimQueuedRestore(), null);
  });
  test('only one restore per app may wait or run (the database says so)', async () => {
    const backup = await aBackup();
    await queue(backup);
    await assert.rejects(queue(backup), /volume_restores_one_active/);
  });
  test('a failure clears the stored passphrase and records the reason, cut to a sensible length', async () => {
    const row = await ask(await aBackup());
    await pool.query(`UPDATE volume_restores SET passphrase_enc = 'x' WHERE id = $1`, [row.id]);
    await db.markRestoreFailed(row.id, 'e'.repeat(5000));
    const done = await restoreRow(row.id);
    assert.deepEqual([done.status, done.passphrase_enc, done.error.length], ['failed', null, 1000]);
  });
});

describe('the runner', () => {
  beforeEach(() => putSetting('backup_schedule', { frequency: 'off', hour: 3, weekday: 1, keep: 7 })); // (no scheduled backup of its own to answer first)
  test('answers a waiting restore by itself (after any waiting backup), and records it', async () => {
    const backup = await aBackup();
    const id = (await pool.query(`INSERT INTO volume_restores (backup_id, app_id, app_name, mode, safety_backup) VALUES ($1, $2, 'x', 'replace', false) RETURNING id`, [backup, appId])).rows[0].id;
    const runner = createBackupRunner({ db, eng: engine(), secretsKey: KEY, dir, secretsDir: dir, version: '0.1.20', log });
    assert.equal(await runner.tick(), true);
    assert.equal((await restoreRow(id)).status, 'ok');
    assert.equal(await read(vols['vol-data'], 'a.txt'), 'from the backup');
    assert.equal(await runner.tick(), false, 'nothing more to do');
  });
  test('a waiting backup is answered before a waiting restore', async () => {
    const backup = await aBackup();
    const rid = (await pool.query(`INSERT INTO volume_restores (backup_id, app_id, app_name, mode, safety_backup) VALUES ($1, $2, 'x', 'replace', false) RETURNING id`, [backup, appId])).rows[0].id;
    const other = await makeApp();
    await pool.query(`INSERT INTO app_volumes (app_id, app_name, container_path, docker_name) VALUES ($1, 'A', '/data', 'vol-other')`, [other]);
    vols['vol-other'] = await mkdtemp(join(tmpdir(), 'rr-o-'));
    const bid = await db.requestVolumeBackup(other, 'manual');
    const runner = createBackupRunner({ db, eng: engine(), secretsKey: KEY, dir, secretsDir: dir, version: '0.1.20', log });
    await runner.tick();
    assert.equal((await backupRow(bid)).status, 'ok');
    assert.equal((await restoreRow(rid)).status, 'queued');
  });
});

describe('after the worker was stopped', () => {
  test('a restore that was running is marked failed with a warning about the files, and the app it had stopped is started again', async () => {
    await runtime('stopped');
    const row = await ask(await aBackup());
    const eng = engine();
    await recoverAfterStop({ db, eng, log });
    const done = await restoreRow(row.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /Interrupted.*only partly restored/);
    assert.deepEqual(orderOf(eng), ['start live-1']);
  });
  test('an app the administrator had stopped is left stopped', async () => {
    await setApp(appId, { desired_state: 'stopped' });
    await runtime('stopped');
    await ask(await aBackup());
    const eng = engine();
    await recoverAfterStop({ db, eng, log });
    assert.deepEqual(orderOf(eng), []);
  });
});

describe('the restore history', () => {
  // n finished restores of an app (1 = the newest minute ago); ids oldest to newest
  const history = async (id, n, { status = 'ok', name = appName } = {}) => (await pool.query(
    `INSERT INTO volume_restores (app_id, app_name, mode, safety_backup, status, requested_at, finished_at)
     SELECT $1, $4, 'add', true, $3, now() - make_interval(mins => g), now() - make_interval(mins => g) FROM generate_series($2::int, 1, -1) g RETURNING id`, [id, n, status, name])).rows.map((r) => r.id);
  const idsOf = async (id) => (await pool.query('SELECT id FROM volume_restores WHERE app_id = $1 ORDER BY requested_at DESC', [id])).rows.map((r) => r.id);

  test('an app keeps its newest finished restores, as many as it chose (10 unless said)', async () => {
    const ids = await history(appId, 13);
    assert.equal(await db.pruneRestores(), 3);
    assert.deepEqual(await idsOf(appId), ids.slice(3).reverse());
    await setApp(appId, { restore_history_keep: 2 });
    assert.equal(await db.pruneRestores(), 8);
    assert.deepEqual(await idsOf(appId), [ids[12], ids[11]]);
  });
  test('NULL keeps them all', async () => {
    await setApp(appId, { restore_history_keep: null });
    await history(appId, 30);
    assert.equal(await db.pruneRestores(), 0);
    assert.equal((await idsOf(appId)).length, 30);
  });
  test('failed ones count like done ones; waiting and running ones are never removed and do not count', async () => {
    await setApp(appId, { restore_history_keep: 1 });
    await history(appId, 2, { status: 'failed' });
    await history(appId, 1, { status: 'ok' });
    await pool.query(`INSERT INTO volume_restores (app_id, app_name, mode, safety_backup, status, requested_at) VALUES ($1, 'x', 'add', true, 'queued', now() - interval '3 days')`, [appId]);
    await db.pruneRestores();
    const left = (await pool.query('SELECT status FROM volume_restores WHERE app_id = $1 ORDER BY status', [appId])).rows.map((r) => r.status);
    assert.deepEqual(left, ['ok', 'queued']);
  });
  test('each app is counted on its own', async () => {
    const other = await makeApp();
    await setApp(appId, { restore_history_keep: 1 });
    await setApp(other, { restore_history_keep: 3 });
    await history(appId, 4);
    await history(other, 4, { name: 'other' });
    await db.pruneRestores();
    assert.equal((await idsOf(appId)).length, 1);
    assert.equal((await idsOf(other)).length, 3);
  });
  test('the restores of an app that was deleted are counted by its name, keeping 10', async () => {
    await pool.query(`INSERT INTO volume_restores (app_id, app_name, mode, safety_backup, status, requested_at, finished_at) SELECT NULL, 'Gone', 'add', true, 'ok', now() - make_interval(mins => g), now() - make_interval(mins => g) FROM generate_series(1, 14) g`);
    await pool.query(`INSERT INTO volume_restores (app_id, app_name, mode, safety_backup, status, requested_at, finished_at) SELECT NULL, 'Other gone', 'add', true, 'ok', now() - make_interval(mins => g), now() - make_interval(mins => g) FROM generate_series(1, 3) g`);
    assert.equal(await db.pruneRestores(), 4);
    const left = (await pool.query(`SELECT app_name, count(*)::int AS n FROM volume_restores GROUP BY app_name ORDER BY app_name`)).rows;
    assert.deepEqual(left, [{ app_name: 'Gone', n: 10 }, { app_name: 'Other gone', n: 3 }]);
  });
  test('the runner trims the history right after it answers a restore', async () => {
    await putSetting('backup_schedule', { frequency: 'off', hour: 3, weekday: 1, keep: 7 });
    await setApp(appId, { restore_history_keep: 2 });
    const old = await history(appId, 4);
    const backup = await aBackup();
    const id = (await pool.query(`INSERT INTO volume_restores (backup_id, app_id, app_name, mode, safety_backup) VALUES ($1, $2, 'x', 'replace', false) RETURNING id`, [backup, appId])).rows[0].id;
    const runner = createBackupRunner({ db, eng: engine(), secretsKey: KEY, dir, secretsDir: dir, version: '0.1.23', log });
    assert.equal(await runner.tick(), true);
    assert.equal((await restoreRow(id)).status, 'ok');
    assert.deepEqual(await idsOf(appId), [id, old[3]]);
  });
  test('a history that cannot be trimmed is logged and does not stop the runner', async () => {
    await putSetting('backup_schedule', { frequency: 'off', hour: 3, weekday: 1, keep: 7 });
    const backup = await aBackup();
    const id = (await pool.query(`INSERT INTO volume_restores (backup_id, app_id, app_name, mode, safety_backup) VALUES ($1, $2, 'x', 'replace', false) RETURNING id`, [backup, appId])).rows[0].id;
    const broken = Object.assign(Object.create(db), { pruneRestores: async () => { throw new Error('no way'); } });
    const runner = createBackupRunner({ db: new Proxy(db, { get: (t, k) => (k === 'pruneRestores' ? broken.pruneRestores : t[k]) }), eng: engine(), secretsKey: KEY, dir, secretsDir: dir, version: '0.1.23', log });
    assert.equal(await runner.tick(), true);
    assert.equal((await restoreRow(id)).status, 'ok');
    assert.ok(logs.some((l) => /restore history: no way/.test(l)), logs.join('\n'));
  });
});
