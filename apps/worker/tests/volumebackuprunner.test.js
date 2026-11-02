// Backups of an app's volumes as the worker answers them: the requests, stopping the app for the copy, the schedule, keeping the newest per app.
// The real test database; Docker is a fake (the "volumes" are folders, the copy is made by the real tar).
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptSecret } from '@shipdok/shared';
import * as db from '../src/db.js';
import { answerBackup, prune, recoverAfterStop, requestIfDue, requestVolumeBackupsIfDue, PASSPHRASE_CONTEXT } from '../src/backuprunner.js';
import { createActivity } from '../src/activity.js';
import { fakeEngine } from './fake-engine.js';
import { KEY, ready, reset, makeApp, pool } from './helpers.js';

const GB = 1024 ** 3;
const DAY = 86_400_000;
let dir; let source; let logs; let appId;
const log = (m) => logs.push(m);
const rowOf = async (id) => (await pool.query('SELECT * FROM backups WHERE id = $1', [id])).rows[0];
const putSetting = (key, value, at = null) => pool.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, COALESCE($3, now())) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = COALESCE($3, now())`, [key, JSON.stringify(value), at]);
const addVolume = (id, path = '/data', docker = `shipdok-vol-${path.replace(/\W/g, '')}`, state = 'in_use') =>
  pool.query(`INSERT INTO app_volumes (app_id, app_name, container_path, docker_name, state) VALUES ($1, 'A', $2, $3, $4)`, [id, path, docker, state]);
const setApp = (id, fields) => pool.query(`UPDATE apps SET ${Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...Object.values(fields)]);
const runtime = (id, state) => db.setRuntime(id, { state, action: 'start' });

// A fake Docker: the control actions (stop, start) and the copy all write to the engine's `events`, so their ORDER can be checked.
const engine = (over = {}) => {
  const base = fakeEngine({ previous: ['live-1'] });
  const note = (e) => base.events.push(e);
  return Object.assign(base, {
    appImage: async () => 'sha256:img',
    createBackupHelper: async () => { note('helper created'); return { remove: async () => { note('helper removed'); } }; },
    archiveVolume: async (h, i, file) => { note(`copy ${i}`); execFileSync('tar', ['cf', file, '-C', source, '.']); },
    volumeSizes: async () => new Map(),
    diskSpace: async () => ({ totalBytes: 100 * GB, freeBytes: 90 * GB }),
    removeStaleHelpers: async () => { note('stale helpers removed'); return 0; },
  }, over);
};
const answerWith = async (request, o = {}) => {
  const eng = o.eng ?? engine();
  const r = await answerBackup(request, { db, secretsKey: KEY, dir, secretsDir: dir, version: '0.1.19', log, ...o, eng });
  return { r, eng };
};
const orderOf = (eng) => eng.events.filter((e) => /^(stop|start|helper|copy)/.test(e));

before(ready);
after(() => pool.end());
beforeEach(async () => {
  await reset();
  await pool.query('TRUNCATE volume_restores, backups, app_volumes');
  await pool.query(`DELETE FROM settings WHERE key IN ('backup_schedule', 'backup_passphrase')`);
  dir = await mkdtemp(join(tmpdir(), 'vbr-dir-'));
  source = await mkdtemp(join(tmpdir(), 'vbr-src-'));
  await writeFile(join(source, 'data.txt'), 'the app\'s data');
  logs = [];
  appId = await makeApp();
  await addVolume(appId, '/data');
});

describe('asking for a volume backup', () => {
  test('is recorded for the app, with its name, and only one may wait or run per app', async () => {
    const id = await db.requestVolumeBackup(appId, 'manual');
    const row = await rowOf(id);
    assert.deepEqual([row.kind, row.app_id, row.app_name, row.status, row.trigger], ['volumes', appId, (await pool.query('SELECT name FROM apps WHERE id = $1', [appId])).rows[0].name, 'queued', 'manual']);
    assert.equal(await db.requestVolumeBackup(appId, 'scheduled'), null);
    await pool.query(`UPDATE backups SET status = 'running'`);
    assert.equal(await db.requestVolumeBackup(appId, 'manual'), null, 'a running one blocks too');
    await pool.query(`UPDATE backups SET status = 'ok', filename = NULL`);
    assert.ok(await db.requestVolumeBackup(appId, 'manual'), 'a finished one does not');
  });
  test('Shipdok\'s own backup and each app\'s may all wait at once', async () => {
    const other = await makeApp(); await addVolume(other, '/x', 'shipdok-vol-x');
    assert.ok(await db.requestBackup('manual'));
    assert.ok(await db.requestVolumeBackup(appId, 'manual'));
    assert.ok(await db.requestVolumeBackup(other, 'manual'));
    assert.equal(await db.requestBackup('manual'), null);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM backups WHERE status = 'queued'`)).rows[0].n, 3);
  });
  test('nothing is asked for an app with no mounted volume (a detached one does not count), or one that is being deleted', async () => {
    const bare = await makeApp();
    assert.equal(await db.requestVolumeBackup(bare, 'manual'), null);
    await addVolume(bare, '/old', 'shipdok-vol-old', 'detached');
    assert.equal(await db.requestVolumeBackup(bare, 'manual'), null);
    await setApp(appId, { deleting_at: new Date() });
    assert.equal(await db.requestVolumeBackup(appId, 'manual'), null);
  });
  test('the waiting requests are taken oldest first and say what they are for', async () => {
    const second = await db.requestBackup('manual');
    const first = await db.requestVolumeBackup(appId, 'manual');
    await pool.query(`UPDATE backups SET requested_at = now() - interval '1 hour' WHERE id = $1`, [first]);
    const a = await db.claimQueuedBackup();
    assert.deepEqual([a.id, a.kind, a.app_id], [first, 'volumes', appId]);
    const b = await db.claimQueuedBackup();
    assert.deepEqual([b.id, b.kind, b.app_id], [second, 'platform', null]);
  });
});

describe('answering (the app keeps running)', () => {
  test('makes the file, records the number of volumes, and does not touch the app', async () => {
    await addVolume(appId, '/uploads');
    await runtime(appId, 'running');
    const id = await db.requestVolumeBackup(appId, 'manual');
    const { r, eng } = await answerWith(await db.claimQueuedBackup());
    assert.equal(r.ok, true, r.error);
    const row = await rowOf(id);
    assert.deepEqual([row.status, row.kind, row.volume_count, row.encrypted, row.verified, row.error], ['ok', 'volumes', 2, false, true, null]);
    assert.match(row.filename, /^shipdok-volumes-/);
    assert.deepEqual(await readdir(dir), [row.filename]);
    assert.deepEqual(orderOf(eng), ['helper created', 'copy 0', 'copy 1', 'helper removed'], 'no stop, no start');
  });
  test('with a passphrase set the file is encrypted (the same passphrase as Shipdok\'s own backups)', async () => {
    await putSetting('backup_passphrase', encryptSecret('correct horse battery staple', KEY, PASSPHRASE_CONTEXT));
    const id = await db.requestVolumeBackup(appId, 'manual');
    await answerWith(await db.claimQueuedBackup());
    const row = await rowOf(id);
    assert.deepEqual([row.encrypted, row.filename.endsWith('.tar.enc')], [true, true]);
  });
  test('a failure is recorded with its reason, leaves no file and removes the helper', async () => {
    const id = await db.requestVolumeBackup(appId, 'manual');
    const eng = engine({ archiveVolume: async () => { throw new Error('docker: read failed'); } });
    const { r } = await answerWith(await db.claimQueuedBackup(), { eng });
    assert.equal(r.ok, false);
    const row = await rowOf(id);
    assert.deepEqual([row.status, row.error, row.filename], ['failed', 'docker: read failed', null]);
    assert.deepEqual(await readdir(dir), []);
    assert.ok(orderOf(eng).includes('helper removed'));
  });
  test('a disk that would be left nearly full refuses, with the reason, before any copy', async () => {
    await pool.query(`UPDATE app_volumes SET size_bytes = $1`, [60 * GB]);
    const id = await db.requestVolumeBackup(appId, 'manual');
    const eng = engine();
    await answerWith(await db.claimQueuedBackup(), { eng });
    const row = await rowOf(id);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /Not enough free disk space/);
    assert.deepEqual(orderOf(eng), []);
  });
  test('an app that began to be deleted meanwhile fails with a message and nothing is copied', async () => {
    const id = await db.requestVolumeBackup(appId, 'manual');
    const request = await db.claimQueuedBackup();
    await setApp(appId, { deleting_at: new Date() });
    const { eng } = await answerWith(request);
    assert.match((await rowOf(id)).error, /being deleted/);
    assert.deepEqual(orderOf(eng), []);
  });
  test('an app that was deleted meanwhile fails with a message instead of a crash', async () => {
    const id = await db.requestVolumeBackup(appId, 'manual');
    const request = await db.claimQueuedBackup();
    await pool.query('DELETE FROM apps WHERE id = $1', [appId]);
    const { r } = await answerWith(request);
    assert.equal(r.ok, false);
    assert.match((await rowOf(id)).error, /no longer exists/);
  });
});

describe('stopping the app for the copy', () => {
  const asked = async () => { const id = await db.requestVolumeBackup(appId, 'manual'); return { id, request: await db.claimQueuedBackup() }; };
  beforeEach(async () => { await setApp(appId, { volume_backup_stop: true, desired_state: 'running' }); await runtime(appId, 'running'); });

  test('stops it, copies, then starts it again, in that order', async () => {
    const { id, request } = await asked();
    const { eng } = await answerWith(request);
    assert.deepEqual(orderOf(eng), ['stop live-1', 'helper created', 'copy 0', 'helper removed', 'start live-1']);
    assert.equal((await rowOf(id)).status, 'ok');
    assert.equal((await pool.query('SELECT state FROM app_runtime WHERE app_id = $1', [appId])).rows[0].state, 'running');
  });
  test('the monitor is told to leave the app alone while it is stopped, and not afterwards', async () => {
    const activity = createActivity();
    const during = [];
    const eng = engine({ archiveVolume: async (h, i, file) => { during.push(activity.isBusy(appId)); execFileSync('tar', ['cf', file, '-C', source, '.']); } });
    const { request } = await asked();
    await answerWith(request, { eng, activity });
    assert.deepEqual(during, [true]);
    assert.equal(activity.isBusy(appId), false);
  });
  test('is started again even when the copy failed, and the backup says the copy failed', async () => {
    const { id, request } = await asked();
    const eng = engine({ archiveVolume: async () => { throw new Error('read error'); } });
    await answerWith(request, { eng });
    assert.deepEqual(orderOf(eng), ['stop live-1', 'helper created', 'helper removed', 'start live-1']);
    const row = await rowOf(id);
    assert.deepEqual([row.status, row.error], ['failed', 'read error']);
  });
  test('an app that does not come back is reported on the backup (a warning when it worked, added to the error when it did not)', async () => {
    const eng = engine({ startContainer: async () => { throw new Error('port in use'); } });
    const { id, request } = await asked();
    await answerWith(request, { eng });
    const row = await rowOf(id);
    assert.equal(row.status, 'ok');
    assert.match(row.warning, /could not be started again after the copy: port in use/);

    await pool.query('TRUNCATE volume_restores, backups');
    await runtime(appId, 'running');
    const eng2 = engine({ startContainer: async () => { throw new Error('port in use'); }, archiveVolume: async () => { throw new Error('read error'); } });
    const again = await asked();
    await answerWith(again.request, { eng: eng2 });
    assert.match((await rowOf(again.id)).error, /^read error\. The app could not be started again after the copy: port in use/);
  });
  test('an app the administrator stopped is copied as it is and stays stopped', async () => {
    await runtime(appId, 'stopped');
    const { id, request } = await asked();
    const { eng } = await answerWith(request);
    assert.deepEqual(orderOf(eng), ['helper created', 'copy 0', 'helper removed']);
    assert.equal((await rowOf(id)).status, 'ok');
  });
  test('an app the administrator stops meanwhile is not started afterwards', async () => {
    const { request } = await asked();
    const eng = engine({ archiveVolume: async (h, i, file) => { await setApp(appId, { desired_state: 'stopped' }); execFileSync('tar', ['cf', file, '-C', source, '.']); } });
    await answerWith(request, { eng });
    assert.deepEqual(orderOf(eng), ['stop live-1', 'helper created', 'helper removed']);
  });
  test('a deployment or another job working on the app means nothing is stopped: the backup fails and says why', async () => {
    const activity = createActivity();
    const { id, request } = await asked();
    let eng;
    await activity.run(appId, async () => { ({ eng } = await answerWith(request, { activity })); });
    assert.deepEqual(orderOf(eng), []);
    const row = await rowOf(id);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /working on this app right now/);
  });
  test('an app that could not be stopped is not copied', async () => {
    const eng = engine({ stopContainer: async () => { throw new Error('docker is busy'); } });
    const { id, request } = await asked();
    await answerWith(request, { eng });
    const row = await rowOf(id);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /could not be stopped for the copy: docker is busy/);
    assert.ok(!orderOf(eng).includes('helper created'));
  });
  test('with the switch off the app is never stopped', async () => {
    await setApp(appId, { volume_backup_stop: false });
    const { request } = await asked();
    const { eng } = await answerWith(request);
    assert.ok(!orderOf(eng).some((e) => /^(stop|start)/.test(e)));
  });
});

describe('the schedule', () => {
  const NOW = Date.parse('2026-10-22T12:00:00Z'); // after today's 03:00 slot
  const SLOT = Date.parse('2026-10-22T03:00:00Z');
  const scheduled = (extra = {}) => setApp(appId, { volume_backup_frequency: 'daily', ...extra });
  const count = async () => (await pool.query(`SELECT count(*)::int AS n FROM backups WHERE kind = 'volumes'`)).rows[0].n;
  const ask = () => requestVolumeBackupsIfDue({ db, now: NOW, log });

  test('an app that is in the schedule gets its backup when the slot has passed', async () => {
    await scheduled();
    assert.equal(await ask(), 1);
    const row = (await pool.query(`SELECT * FROM backups WHERE kind = 'volumes'`)).rows[0];
    assert.deepEqual([row.app_id, row.trigger, row.status], [appId, 'scheduled', 'queued']);
  });
  test('an app that is not in the schedule (the default) gets none', async () => {
    assert.equal(await ask(), 0);
    assert.equal(await count(), 0);
  });
  test('an app whose own schedule is off gets none, and Shipdok\'s own schedule does not matter either way', async () => {
    await scheduled({ volume_backup_frequency: 'off' });
    assert.equal(await ask(), 0);
    await scheduled();
    await putSetting('backup_schedule', { frequency: 'off', hour: 3, weekday: 1, keep: 7 }, new Date(SLOT - DAY));
    assert.equal(await ask(), 1, 'the shared schedule is off, the app\'s is not');
  });
  test('an app has its own hour: not before it, once after it', async () => {
    await scheduled({ volume_backup_hour: 15 }); // 15:00 UTC; NOW is 12:00, so the latest slot was yesterday 15:00
    await pool.query(`INSERT INTO backups (kind, app_id, app_name, trigger, status, started_at, finished_at) VALUES ('volumes', $1, 'A', 'manual', 'ok', $2, $2)`, [appId, new Date(NOW - 3600_000)]);
    assert.equal(await ask(), 0, 'a backup an hour ago is after yesterday\'s 15:00 slot');
    assert.equal(await requestVolumeBackupsIfDue({ db, now: Date.parse('2026-10-22T16:00:00Z'), log }), 1, 'today\'s 15:00 has passed since that backup');
  });
  test('weekly means that weekday, at that hour', async () => {
    // 2026-10-22 is a Thursday (4). The latest Monday (1) slot was 2026-10-19 03:00.
    await scheduled({ volume_backup_frequency: 'weekly', volume_backup_weekday: 1 });
    await pool.query(`INSERT INTO backups (kind, app_id, app_name, trigger, status, started_at, finished_at) VALUES ('volumes', $1, 'A', 'manual', 'ok', $2, $2)`, [appId, new Date('2026-10-20T10:00:00Z')]);
    assert.equal(await ask(), 0, 'one made on Tuesday covers Monday\'s slot');
    await setApp(appId, { volume_backup_weekday: 4 }); // Thursday: today 03:00 has passed, the Tuesday backup is older
    assert.equal(await ask(), 1);
  });
  test('two apps with different schedules are asked for on their own', async () => {
    const other = await makeApp(); await addVolume(other, '/x', 'shipdok-vol-x');
    await scheduled();
    await setApp(other, { volume_backup_frequency: 'daily', volume_backup_hour: 15 });
    await pool.query(`INSERT INTO backups (kind, app_id, app_name, trigger, status, started_at, finished_at) VALUES ('volumes', $1, 'A', 'manual', 'ok', $2, $2)`, [other, new Date(NOW - 3600_000)]);
    assert.equal(await ask(), 1, 'only the first is due');
    const row = (await pool.query(`SELECT app_id FROM backups WHERE status = 'queued'`)).rows[0];
    assert.equal(row.app_id, appId);
  });
  test('only once per slot: a volume backup that started after the slot is enough', async () => {
    await scheduled();
    await pool.query(`INSERT INTO backups (kind, app_id, app_name, trigger, status, started_at, finished_at) VALUES ('volumes', $1, 'A', 'manual', 'ok', $2, $2)`, [appId, new Date(SLOT + 60_000)]);
    assert.equal(await ask(), 0);
    await pool.query('TRUNCATE volume_restores, backups');
    await pool.query(`INSERT INTO backups (kind, app_id, app_name, trigger, status, started_at, finished_at) VALUES ('volumes', $1, 'A', 'manual', 'ok', $2, $2)`, [appId, new Date(SLOT - 60_000)]);
    assert.equal(await ask(), 1, 'one from before the slot is not enough');
  });
  test('changing an app\'s schedule after today\'s slot does not back up for that slot', async () => {
    await scheduled({ volume_backup_changed_at: new Date(SLOT + 3600_000) });
    assert.equal(await ask(), 0);
    await setApp(appId, { volume_backup_changed_at: new Date(SLOT - DAY) });
    assert.equal(await ask(), 1);
  });
  test('an app without a mounted volume, or being deleted, is skipped', async () => {
    await scheduled();
    await pool.query(`UPDATE app_volumes SET state = 'detached'`);
    assert.equal(await ask(), 0);
    await pool.query(`UPDATE app_volumes SET state = 'in_use'`);
    await setApp(appId, { deleting_at: new Date() });
    assert.equal(await ask(), 0);
  });
  test('each app is asked for on its own, and one already waiting is not asked for twice', async () => {
    const other = await makeApp(); await addVolume(other, '/x', 'shipdok-vol-x');
    await scheduled(); await setApp(other, { volume_backup_frequency: 'daily' });
    assert.equal(await ask(), 2);
    assert.equal(await ask(), 0);
  });
  test('a volume backup does not stand in for Shipdok\'s own, and the other way round', async () => {
    await pool.query(`INSERT INTO backups (kind, app_id, app_name, trigger, status, started_at, finished_at) VALUES ('volumes', $1, 'A', 'manual', 'ok', $2, $2)`, [appId, new Date(SLOT + 60_000)]);
    assert.equal(await requestIfDue({ db, now: NOW, log }), true, 'Shipdok\'s own backup is still due');
    await pool.query('TRUNCATE volume_restores, backups');
    await scheduled();
    await db.requestBackup('manual'); await pool.query(`UPDATE backups SET status = 'ok', started_at = $1, finished_at = $1`, [new Date(SLOT + 60_000)]);
    assert.equal(await ask(), 1, 'the app\'s is still due');
  });
});

describe('keeping the newest', () => {
  let n = 0;
  const volumeBackup = async (id, status, ageMinutes, name = null) => {
    n += 1;
    const file = status === 'ok' ? `shipdok-volumes-20260101-0000${String(n).padStart(2, '0')}-${String(n).padStart(8, '0')}.tar` : null;
    if (file) await writeFile(join(dir, file), 'x');
    const { rows } = await pool.query(
      `INSERT INTO backups (kind, app_id, app_name, status, trigger, filename, requested_at, finished_at)
       VALUES ('volumes', $1, $2, $3, 'manual', $4, now() - make_interval(mins => $5), now() - make_interval(mins => $5)) RETURNING id`, [id, name ?? 'A', status, file, ageMinutes]);
    return { id: rows[0].id, file };
  };
  const platform = async (ageMinutes) => {
    n += 1;
    const file = `shipdok-backup-20260101-0000${String(n).padStart(2, '0')}-${String(n).padStart(8, '0')}.tar`;
    await writeFile(join(dir, file), 'x');
    const { rows } = await pool.query(`INSERT INTO backups (status, trigger, filename, requested_at, finished_at) VALUES ('ok', 'manual', $1, now() - make_interval(mins => $2), now() - make_interval(mins => $2)) RETURNING id`, [file, ageMinutes]);
    return rows[0].id;
  };
  const left = async () => (await pool.query('SELECT id FROM backups')).rows.map((r) => r.id);

  test('each app keeps the number it is set to, counted on its own (default 2)', async () => {
    const other = await makeApp(); await addVolume(other, '/x', 'shipdok-vol-x');
    await setApp(other, { volume_backup_keep: 1 });
    const a = []; for (let i = 5; i >= 1; i--) a.push(await volumeBackup(appId, 'ok', i * 10));
    const b = []; for (let i = 3; i >= 1; i--) b.push(await volumeBackup(other, 'ok', i * 10));
    assert.equal(await prune({ db, dir, log }), 3 + 2);
    assert.deepEqual((await left()).sort(), [a[3].id, a[4].id, b[2].id].sort(), 'the newest of each stay: 2 for the app on the default, 1 for the other');
    assert.deepEqual((await readdir(dir)).sort(), [a[3].file, a[4].file, b[2].file].sort());
  });
  test('an app set to keep 3 keeps 3', async () => {
    await setApp(appId, { volume_backup_keep: 3 });
    const a = []; for (let i = 5; i >= 1; i--) a.push(await volumeBackup(appId, 'ok', i * 10));
    await prune({ db, dir, log });
    assert.deepEqual((await left()).sort(), [a[2].id, a[3].id, a[4].id].sort());
  });
  test('Shipdok\'s own keep setting does not touch the apps\' backups, nor theirs Shipdok\'s', async () => {
    await putSetting('backup_schedule', { frequency: 'daily', hour: 3, weekday: 1, keep: 1 });
    const p1 = await platform(30); const p2 = await platform(10);
    const v = []; for (let i = 3; i >= 1; i--) v.push(await volumeBackup(appId, 'ok', i * 10));
    await prune({ db, dir, log });
    assert.deepEqual((await left()).sort(), [p2, v[1].id, v[2].id].sort());
    assert.ok(!(await left()).includes(p1));
  });
  test('failed ones: the newest 3 per app are kept', async () => {
    for (let i = 5; i >= 1; i--) await volumeBackup(appId, 'failed', i);
    await prune({ db, dir, log });
    assert.equal((await left()).length, 3);
  });
  test('the backups of a deleted app stay, counted by its name, with the default number', async () => {
    const gone = await makeApp(); await addVolume(gone, '/g', 'shipdok-vol-g');
    const kept = []; for (let i = 5; i >= 1; i--) kept.push(await volumeBackup(gone, 'ok', i * 10, 'Old blog'));
    await pool.query('DELETE FROM app_volumes WHERE app_id = $1', [gone]);
    await pool.query('DELETE FROM apps WHERE id = $1', [gone]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM backups WHERE app_id IS NULL AND app_name = 'Old blog'`)).rows[0].n, 5, 'the rows survive the app');
    await prune({ db, dir, log });
    assert.deepEqual((await left()).sort(), kept.slice(3).map((x) => x.id).sort());
  });
});

describe('after the worker was stopped', () => {
  test('a volume backup that was running is marked failed, helper containers are removed, and an app it had stopped is started again', async () => {
    await setApp(appId, { volume_backup_stop: true, desired_state: 'running' });
    await runtime(appId, 'stopped');
    const id = await db.requestVolumeBackup(appId, 'manual');
    await db.claimQueuedBackup();
    const eng = engine();
    await recoverAfterStop({ db, eng, log });
    assert.equal((await rowOf(id)).status, 'failed');
    assert.deepEqual(orderOf(eng), ['start live-1']);
    assert.ok(eng.events.includes('stale helpers removed'));
  });
  test('an app the administrator stopped, or one with the switch off, is left stopped', async () => {
    await setApp(appId, { volume_backup_stop: true, desired_state: 'stopped' });
    await runtime(appId, 'stopped');
    await db.requestVolumeBackup(appId, 'manual'); await db.claimQueuedBackup();
    const eng = engine();
    await recoverAfterStop({ db, eng, log });
    assert.deepEqual(orderOf(eng), []);
    await setApp(appId, { volume_backup_stop: false, desired_state: 'running' });
    await pool.query('TRUNCATE volume_restores, backups');
    await db.requestVolumeBackup(appId, 'manual'); await db.claimQueuedBackup();
    const eng2 = engine();
    await recoverAfterStop({ db, eng: eng2, log });
    assert.deepEqual(orderOf(eng2), []);
  });
  test('a platform backup that was running only causes the usual failure mark', async () => {
    const id = await db.requestBackup('manual'); await db.claimQueuedBackup();
    const eng = engine();
    await recoverAfterStop({ db, eng, log });
    assert.equal((await rowOf(id)).status, 'failed');
    assert.deepEqual(orderOf(eng), []);
  });
});
