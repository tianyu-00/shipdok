// What the worker writes to the activity log by itself: a crash or an outside stop the monitor saw, a backup that finished or failed (a scheduled one is
// marked as such), a restore that finished or failed. The entries are built by pure functions (audit.js) and written to the real test database.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as db from '../src/db.js';
import { backupEntry, crashEntry, deployEntry, restoreEntry } from '../src/audit.js';
import { answerBackup, answerRestore } from '../src/backuprunner.js';
import { KEY, ready, reset, makeApp, pool } from './helpers.js';

const app = { id: '11111111-1111-4111-8111-111111111111', name: 'Blog' };
const detail = (e, label) => e.details.find((d) => d.label === label);
const rows = async () => (await pool.query('SELECT * FROM audit_log ORDER BY id')).rows;

describe('the entry for what the monitor saw', () => {
  const ev = (cause, action, over = {}) => ({ cause, action, exitCode: 1, oomKilled: false, ...over });

  test('a crash that will be restarted: the exit code, and that it is the machine and the app', () => {
    const e = crashEntry(app, ev('crash', 'restart_scheduled', { exitCode: 137 }));
    assert.deepEqual([e.category, e.action, e.source, e.actor, e.address, e.appId, e.appName], ['apps', 'app_crashed', 'system', 'Shipdok', 'worker', app.id, 'Blog']);
    assert.equal(e.summary, 'Blog crashed and will be restarted');
    assert.equal(detail(e, 'Exit code').value, '137');
    assert.equal(detail(e, 'Out of memory'), undefined);
  });
  test('out of memory is said', () => {
    assert.match(detail(crashEntry(app, ev('crash', 'restart_scheduled', { oomKilled: true })), 'Out of memory').value, /^yes/);
  });
  test('giving up is another entry', () => {
    const e = crashEntry(app, ev('crash', 'gave_up'));
    assert.deepEqual([e.action, e.summary], ['app_gave_up', 'Blog crashed too many times: Shipdok stopped restarting it']);
    assert.match(detail(e, 'Effect').value, /until you start it/);
  });
  for (const [cause, action, summary] of [
    ['stopped_outside', 'app_stopped_outside', 'Blog was stopped outside Shipdok'],
    ['removed_outside', 'app_removed_outside', 'The container of Blog was removed outside Shipdok'],
    ['recovered', 'app_recovered', 'Blog was started again after a host or Docker restart'],
  ]) {
    test(`${cause}`, () => {
      const e = crashEntry(app, ev(cause, 'none'));
      assert.deepEqual([e.action, e.summary, e.source], [action, summary, 'system']);
    });
  }
  test('an exit code that is null is left out', () => {
    assert.equal(detail(crashEntry(app, ev('crash', 'restart_scheduled', { exitCode: null })), 'Exit code'), undefined);
  });
});

describe('the entry for a backup', () => {
  const platform = { id: 'b1', trigger: 'manual', kind: 'platform', app_id: null, app_name: null };
  const volumes = { id: 'b2', trigger: 'scheduled', kind: 'volumes', app_id: app.id, app_name: 'Blog' };

  test('a scheduled one is marked scheduled, a manual one is the machine finishing what was asked', () => {
    assert.equal(backupEntry(volumes, { ok: true, sizeBytes: 5 }).source, 'schedule');
    assert.equal(backupEntry(platform, { ok: true, sizeBytes: 5 }).source, 'system');
  });
  test('a good one of Shipdok: size, encrypted, checked, no app', () => {
    const e = backupEntry(platform, { ok: true, sizeBytes: 1234, encrypted: true, verified: true });
    assert.deepEqual([e.category, e.action, e.summary, e.appId, e.appName], ['backups', 'backup_finished', 'Backup of Shipdok finished', null, null]);
    assert.equal(detail(e, 'Size').value, '1234 bytes');
    assert.equal(detail(e, 'Encrypted').value, 'yes');
    assert.equal(detail(e, 'Read back and checked').value, 'yes');
    assert.equal(detail(e, 'Volumes'), undefined);
  });
  test('a good scheduled one of an app: its name, the volumes, a warning when there is one', () => {
    const e = backupEntry(volumes, { ok: true, sizeBytes: 9, encrypted: false, verified: true, volumeCount: 2, warning: 'The app could not be started again' });
    assert.deepEqual([e.summary, e.appId, e.appName], ["Scheduled backup of Blog's data finished", app.id, 'Blog']);
    assert.equal(detail(e, 'Volumes').value, '2');
    assert.equal(detail(e, 'Encrypted').value, 'no');
    assert.equal(detail(e, 'Warning').value, 'The app could not be started again');
  });
  test('a failed one says why', () => {
    const e = backupEntry(volumes, { ok: false, error: 'Not enough free disk space' });
    assert.deepEqual([e.action, e.summary, detail(e, 'Why').value], ['backup_failed', "Scheduled backup of Blog's data failed", 'Not enough free disk space']);
  });
});

describe('the entry for a restore', () => {
  const restore = { id: 'r1', app_id: app.id, app_name: 'Blog', mode: 'add', safety_backup: true, reclaim: false, backup_app_name: null };

  test('a finished one: the mode in words, the safety backup, how many volumes', () => {
    const e = restoreEntry(restore, { ok: true, volumeCount: 2 });
    assert.deepEqual([e.category, e.action, e.summary, e.source, e.appId, e.appName], ['backups', 'restore_finished', 'Restore of Blog finished', 'system', app.id, 'Blog']);
    assert.match(detail(e, 'Mode').value, /^Add over/);
    assert.equal(detail(e, 'Backup of the current data first').value, 'yes');
    assert.equal(detail(e, 'Volumes restored').value, '2');
    assert.equal(detail(e, 'Reclaim'), undefined);
  });
  test('a note (a path added, an app not started) is kept; a reclaim names the backup it came from', () => {
    const e = restoreEntry({ ...restore, reclaim: true, backup_app_name: 'Old blog' }, { ok: true, volumeCount: 1, warning: 'Added the storage path /data' });
    assert.equal(detail(e, 'Note').value, 'Added the storage path /data');
    assert.equal(detail(e, 'Reclaim').value, 'from the backup of Old blog');
  });
  test('a failed one says why', () => {
    const e = restoreEntry(restore, { ok: false, error: 'The files may be only partly restored' });
    assert.deepEqual([e.action, e.summary, detail(e, 'Why').value], ['restore_failed', 'Restore of Blog failed', 'The files may be only partly restored']);
  });
});

describe('the entry for a deployment that ended', () => {
  const row = { id: 'abcdef12-0000-4000-8000-000000000000', app_id: app.id, name: 'Blog', trigger: 'manual', commit_sha: 'a1b2c3d4e5f6'.repeat(3), rollback_of: null,
    started_at: '2026-11-01T10:00:00Z', finished_at: '2026-11-01T10:02:05Z', error_summary: 'Health check failed' };

  test('each outcome has its own action and words', () => {
    const got = ['successful', 'failed', 'cancelled', 'superseded', 'interrupted'].map((o) => { const e = deployEntry(row, o); return [e.action, e.summary]; });
    assert.deepEqual(got, [
      ['deploy_succeeded', 'Deployment of Blog succeeded'], ['deploy_failed', 'Deployment of Blog failed'], ['deploy_stopped', 'Deployment of Blog was cancelled'],
      ['deploy_superseded', 'Deployment of Blog was replaced by a newer one'], ['deploy_interrupted', 'Deployment of Blog was interrupted: the worker stopped'],
    ]);
  });
  test('it is the machine\'s, of the app, in the deployments category', () => {
    const e = deployEntry(row, 'successful');
    assert.deepEqual([e.category, e.source, e.actor, e.address, e.appId, e.appName], ['deployments', 'system', 'Shipdok', 'worker', app.id, 'Blog']);
  });
  test('the facts: the deployment and the commit (8 characters), who started it, how long it took; the reason only for a failure', () => {
    const ok = deployEntry(row, 'successful');
    assert.equal(detail(ok, 'Deployment').value, 'abcdef12');
    assert.equal(detail(ok, 'Commit').value, 'a1b2c3d4');
    assert.equal(detail(ok, 'Started').value, 'by hand');
    assert.equal(detail(ok, 'Took').value, '2 min 5 s');
    assert.equal(detail(ok, 'Why'), undefined);
    assert.equal(detail(deployEntry(row, 'failed'), 'Why').value, 'Health check failed');
    assert.equal(detail(deployEntry(row, 'cancelled'), 'Why'), undefined);
  });
  test('a push says so, a rollback is worded as one, a short time is in seconds, and what is not known is left out', () => {
    assert.equal(detail(deployEntry({ ...row, trigger: 'webhook' }, 'successful'), 'Started').value, 'by a push to GitHub');
    const back = deployEntry({ ...row, trigger: 'rollback', commit_sha: null, started_at: null }, 'successful');
    assert.equal(back.summary, 'Rollback of Blog finished');
    assert.equal(deployEntry({ ...row, trigger: 'rollback' }, 'failed').summary, 'Rollback of Blog failed');
    assert.equal(detail(back, 'Commit'), undefined);
    assert.equal(detail(back, 'Took'), undefined);
    assert.equal(detail(deployEntry({ ...row, finished_at: '2026-11-01T10:00:09Z' }, 'successful'), 'Took').value, '9 s');
  });
  test('an outcome that does not exist is refused', () => {
    assert.throws(() => deployEntry(row, 'exploded'), /Unknown deployment outcome/);
  });
});

describe('written to the database', () => {
  before(ready);
  after(() => pool.end());
  let appId;
  let dir;
  beforeEach(async () => {
    await reset();
    await pool.query('TRUNCATE audit_log, volume_restores, backups');
    appId = await makeApp();
    dir = await mkdtemp(join(tmpdir(), 'ae-'));
  });
  const update = (event) => ({ state: 'running', action: null, error: null, healthFailures: 0, nextRestartAt: null, death: null, event });

  test('a crash the monitor decided on is an entry of the app, after the runtime update', async () => {
    await db.applyMonitorUpdate(appId, update({ cause: 'crash', exitCode: 2, oomKilled: false, action: 'restart_scheduled' }));
    const [row] = await rows();
    assert.deepEqual([row.category, row.action, row.source, row.actor, row.address, row.app_id], ['apps', 'app_crashed', 'system', 'Shipdok', 'worker', appId]);
    assert.match(row.summary, /crashed and will be restarted$/);
    assert.deepEqual(row.details.find((d) => d.label === 'Exit code'), { label: 'Exit code', value: '2' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_crash_events WHERE app_id = $1', [appId])).rows[0].n, 1);
  });
  test('an update with no event writes no entry', async () => {
    await db.applyMonitorUpdate(appId, update(null));
    assert.equal((await rows()).length, 0);
  });
  test('an entry that cannot be written does not undo or fail the runtime update', async () => {
    await pool.query('ALTER TABLE audit_log RENAME TO audit_log_gone');
    const errors = [];
    const was = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      await db.applyMonitorUpdate(appId, update({ cause: 'crash', exitCode: 2, oomKilled: false, action: 'restart_scheduled' }));
    } finally {
      console.error = was;
      await pool.query('ALTER TABLE audit_log_gone RENAME TO audit_log');
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_crash_events WHERE app_id = $1', [appId])).rows[0].n, 1);
    assert.match(errors.join('\n'), /Activity log entry not written/);
  });
  test('old entries are removed by the kept time when the worker writes one', async () => {
    await pool.query(`INSERT INTO audit_log (at, category, action, summary, actor, address) VALUES (now() - interval '40 days', 'security', 'x', 'old', 'admin', '1.1.1.1')`);
    await db.recordAutomatic(crashEntry({ id: appId, name: 'A' }, { cause: 'recovered', action: 'restarted', exitCode: null, oomKilled: false }));
    assert.deepEqual((await rows()).map((r) => r.action), ['app_recovered']);
  });

  const engine = () => ({
    findPostgresContainer: async () => 'pg',
    execToFile: async (c, cmd, file) => writeFile(file, 'pretend dump'),
    execWithFile: async () => '1; 1262 db\n',
  });
  const claim = async (trigger) => { await db.requestBackup(trigger); return db.claimQueuedBackup(); };
  const secretsDir = async () => { const s = await mkdtemp(join(tmpdir(), 'ae-s-')); await writeFile(join(s, 'app_secrets_key'), 'k'); return s; };

  test('a scheduled backup that finishes is an automatic "schedule" entry; a manual one is "system"', async () => {
    const scheduled = await claim('scheduled');
    const r = await answerBackup(scheduled, { db, eng: engine(), secretsKey: KEY, dir, secretsDir: await secretsDir(), version: '0.1.27', log: () => {} });
    assert.equal(r.ok, true, r.error);
    await db.requestBackup('manual').then(() => db.claimQueuedBackup()).then(async (manual) => {
      await answerBackup(manual, { db, eng: engine(), secretsKey: KEY, dir, secretsDir: await secretsDir(), version: '0.1.27', log: () => {} });
    });
    const got = await rows();
    assert.deepEqual(got.map((x) => [x.action, x.source, x.summary]), [
      ['backup_finished', 'schedule', 'Scheduled backup of Shipdok finished'],
      ['backup_finished', 'system', 'Backup of Shipdok finished'],
    ]);
    assert.equal(got[0].details.find((d) => d.label === 'Read back and checked').value, 'yes');
  });
  test('a backup that fails is an entry with the reason', async () => {
    const request = await claim('scheduled');
    const eng = { ...engine(), execToFile: async () => { throw new Error('pg_dump could not connect'); } };
    const r = await answerBackup(request, { db, eng, secretsKey: KEY, dir, secretsDir: await secretsDir(), version: '0.1.27', log: () => {} });
    assert.equal(r.ok, false);
    const [row] = await rows();
    assert.deepEqual([row.action, row.source, row.summary], ['backup_failed', 'schedule', 'Scheduled backup of Shipdok failed']);
    assert.match(row.details.find((d) => d.label === 'Why').value, /pg_dump could not connect/);
  });
  test('a runner with a database that has no way to write entries still works', async () => {
    const request = await claim('manual');
    const bare = new Proxy(db, { get: (t, k) => (k === 'recordAutomatic' ? undefined : t[k]) });
    const r = await answerBackup(request, { db: bare, eng: engine(), secretsKey: KEY, dir, secretsDir: await secretsDir(), version: '0.1.27', log: () => {} });
    assert.equal(r.ok, true, r.error);
    assert.equal((await rows()).length, 0);
  });
  test('a restore that fails (its backup is gone) is an entry of the app with the reason, and a restore asked for is not one', async () => {
    const { rows: made } = await pool.query(
      `INSERT INTO volume_restores (backup_id, app_id, app_name, mode, safety_backup, status) VALUES (NULL, $1, 'Blog', 'replace', true, 'running') RETURNING *`, [appId]);
    const r = await answerRestore(made[0], { db, eng: {}, secretsKey: KEY, dir, version: '0.1.27', log: () => {} });
    assert.equal(r.ok, false);
    const [row] = await rows();
    assert.deepEqual([row.category, row.action, row.source, row.summary, row.app_id], ['backups', 'restore_failed', 'system', 'Restore of Blog failed', appId]);
    assert.match(row.details.find((d) => d.label === 'Why').value, /no longer exists/);
  });

  const aDeployment = async (status = 'building', over = {}) => (await pool.query(
    `INSERT INTO deployments (app_id, trigger, status, commit_sha, config_snapshot, started_at) VALUES ($1, $2, $3, $4, '{}', now() - interval '30 seconds') RETURNING id`,
    [appId, over.trigger ?? 'webhook', status, over.sha ?? 'f'.repeat(40)])).rows[0].id;
  const deployRows = async () => (await rows()).filter((r) => r.category === 'deployments');

  test('a deployment that succeeds, fails, is cancelled or is replaced is an entry of the app, written when the status is', async () => {
    await db.markSucceeded(await aDeployment(), 'img:1', 100);
    await db.markFailed(await aDeployment(), 'Build failed: exit 2');
    await db.markStopped(await aDeployment('queued'), 'cancelled');
    await db.markStopped(await aDeployment('queued'), 'superseded');
    const got = await deployRows();
    assert.deepEqual(got.map((r) => r.action), ['deploy_succeeded', 'deploy_failed', 'deploy_stopped', 'deploy_superseded']);
    assert.ok(got.every((r) => r.app_id === appId && r.source === 'system'));
    assert.equal(got[0].details.find((d) => d.label === 'Started').value, 'by a push to GitHub');
    assert.equal(got[0].details.find((d) => d.label === 'Took').value, '30 s');
    assert.equal(got[1].details.find((d) => d.label === 'Why').value, 'Build failed: exit 2');
  });
  test('an update that does not end anything (a late or repeated one) adds nothing', async () => {
    const id = await aDeployment();
    await db.markSucceeded(id, 'img:1', 1);
    await db.markFailed(id, 'too late');
    await db.markSucceeded(id, 'img:2', 1);
    await db.markStopped(id, 'cancelled');
    assert.deepEqual((await deployRows()).map((r) => r.action), ['deploy_succeeded']);
  });
  test('a deployment the worker left mid-flight is an interrupted entry; a waiting one is not touched', async () => {
    await aDeployment('building');
    await aDeployment('starting');
    await aDeployment('queued');
    assert.equal(await db.interruptActive(), 2);
    assert.deepEqual((await deployRows()).map((r) => r.action), ['deploy_interrupted', 'deploy_interrupted']);
  });
  test('an entry that cannot be written does not stop the deployment from ending', async () => {
    const id = await aDeployment();
    await pool.query('ALTER TABLE audit_log RENAME TO audit_log_gone');
    const was = console.error;
    console.error = () => {};
    try {
      const r = await db.markSucceeded(id, 'img:1', 1);
      assert.equal(r.rowCount, 1);
    } finally {
      console.error = was;
      await pool.query('ALTER TABLE audit_log_gone RENAME TO audit_log');
    }
    assert.equal((await pool.query('SELECT status FROM deployments WHERE id = $1', [id])).rows[0].status, 'successful');
  });
  test('a backup and a restore the worker stopped in the middle of are failed entries; a safety backup made for a restore is not one of its own', async () => {
    const other = await makeApp(); // (only one backup of an app may run at a time)
    await pool.query(`INSERT INTO backups (status, trigger, kind, app_id, app_name) VALUES ('running', 'scheduled', 'volumes', $1, 'Blog'), ('running', 'before_restore', 'volumes', $2, 'Other')`, [appId, other]);
    await pool.query(`INSERT INTO volume_restores (app_id, app_name, mode, safety_backup, status) VALUES ($1, 'Blog', 'replace', true, 'running')`, [appId]);
    assert.equal((await db.interruptRunningBackups()).length, 2);
    assert.equal((await db.interruptRunningRestores()).length, 1);
    const got = (await rows()).map((r) => [r.action, r.source, r.summary]);
    assert.deepEqual(got, [
      ['backup_failed', 'schedule', "Scheduled backup of Blog's data failed"],
      ['restore_failed', 'system', 'Restore of Blog failed'],
    ]);
    assert.match((await rows())[0].details.find((d) => d.label === 'Why').value, /^Interrupted: the worker stopped/);
  });
});
