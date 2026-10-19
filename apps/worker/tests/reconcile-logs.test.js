// At boot the worker tidies the log directory: closes logs a dead worker left open, and removes the logs of
// deployments that no longer exist. It only ever touches directories that are clearly its own.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/db.js';
import { reconcileLogs } from '../src/reconcile.js';
import { logFilePath, logDirFor } from '@shipdok/shared';
import { pool, ready, reset, makeApp, makeDeployment } from './helpers.js';

before(ready);
beforeEach(reset);
after(() => pool.end());

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'reclogs-')); });
after(() => rmSync(root, { recursive: true, force: true }));

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const put = (appId, depId, name, content) => {
  mkdirSync(logDirFor(root, appId, depId), { recursive: true });
  writeFileSync(join(logDirFor(root, appId, depId), name), content);
};
const go = () => reconcileLogs(root, { db: store, log: () => {} });
const row = async (depId) => (await pool.query(`SELECT * FROM log_files WHERE deployment_id = $1 AND kind = 'build'`, [depId])).rows[0];

describe('logs a dead worker left open', () => {
  test('are closed with the size that really reached the disk', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    put(appId, depId, 'build.log', 'x'.repeat(777));
    await store.openLogFile(appId, depId, 'build');
    const report = await go();
    const r = await row(depId);
    assert.notEqual(r.ended_at, null);
    assert.equal(Number(r.bytes), 777);
    assert.equal(report.logsClosed, 1);
  });

  test('a record whose file never got written is closed with size 0', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    await store.openLogFile(appId, depId, 'build');
    await go();
    const r = await row(depId);
    assert.deepEqual([r.ended_at !== null, Number(r.bytes)], [true, 0]);
  });

  test('logs that were already closed are left exactly as they are', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    put(appId, depId, 'build.log', 'x'.repeat(50));
    await store.openLogFile(appId, depId, 'build');
    await store.closeLogFile(depId, 'build', { bytes: 50, truncated: true });
    await go();
    const r = await row(depId);
    assert.deepEqual([Number(r.bytes), r.truncated], [50, true]);
  });
});

const putApp = (appId, name, content) => {
  mkdirSync(join(root, appId), { recursive: true });
  writeFileSync(join(root, appId, name), content);
};

describe('runtime logs a dead worker left open', () => {
  test('the current log is closed with the size of ITS file, and the previous run\'s finished record is left alone', async () => {
    const appId = await makeApp();
    putApp(appId, 'runtime.log', 'r'.repeat(321));
    putApp(appId, 'runtime.previous.log', 'p'.repeat(120));
    await pool.query(`INSERT INTO runtime_logs (app_id, kind) VALUES ($1, 'runtime')`, [appId]);
    await pool.query(`INSERT INTO runtime_logs (app_id, kind, bytes, ended_at) VALUES ($1, 'runtime_previous', 99, now())`, [appId]);
    const report = await go();
    const rows = Object.fromEntries((await pool.query('SELECT * FROM runtime_logs WHERE app_id = $1', [appId])).rows.map((r) => [r.kind, r]));
    assert.equal(Number(rows.runtime.bytes), 321);
    assert.equal(Number(rows.runtime_previous.bytes), 99);
    assert.ok(rows.runtime.ended_at !== null);
    assert.equal(report.logsClosed, 1);
  });

  test('a cut-short flag is not forgotten, and a record without a file closes at 0', async () => {
    const appId = await makeApp();
    const other = await makeApp();
    putApp(appId, 'runtime.log', 'r'.repeat(50));
    await pool.query(`INSERT INTO runtime_logs (app_id, kind, truncated) VALUES ($1, 'runtime', true)`, [appId]);
    await pool.query(`INSERT INTO runtime_logs (app_id, kind) VALUES ($1, 'runtime')`, [other]);
    await go();
    const q = (id) => pool.query(`SELECT truncated, bytes, ended_at FROM runtime_logs WHERE app_id = $1 AND kind = 'runtime'`, [id]).then((r) => r.rows[0]);
    const r = await q(appId);
    assert.deepEqual([r.truncated, Number(r.bytes), r.ended_at !== null], [true, 50, true]);
    assert.deepEqual([Number((await q(other)).bytes)], [0]);
  });

  test('the app\'s runtime logs are never mistaken for an orphan deployment\'s', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    put(appId, depId, 'build.log', 'b');
    putApp(appId, 'runtime.log', 'keep');
    putApp(appId, 'runtime.previous.log', 'keep');
    await go();
    assert.ok(existsSync(join(root, appId, 'runtime.log')));
    assert.ok(existsSync(join(root, appId, 'runtime.previous.log')));
  });
});

describe('runtime logs an older version kept inside each deployment', () => {
  test('are removed, the build log beside them stays, and so does the app\'s own runtime log', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    put(appId, depId, 'build.log', 'keep');
    put(appId, depId, 'runtime.log', 'old');
    put(appId, depId, 'runtime.previous.log', 'old');
    putApp(appId, 'runtime.log', 'current');
    const report = await go();
    assert.ok(existsSync(logFilePath(root, appId, depId, 'build')));
    assert.ok(!existsSync(join(logDirFor(root, appId, depId), 'runtime.log')));
    assert.ok(!existsSync(join(logDirFor(root, appId, depId), 'runtime.previous.log')));
    assert.ok(existsSync(join(root, appId, 'runtime.log')));
    assert.equal(report.legacyRuntimeLogsRemoved, 2);
  });
});

describe('logs of deployments that no longer exist', () => {
  test('are removed, and the app directory with them when it is empty', async () => {
    put(UUID_A, UUID_D, 'build.log', 'orphan');
    const report = await go();
    assert.ok(!existsSync(logDirFor(root, UUID_A, UUID_D)));
    assert.ok(!existsSync(join(root, UUID_A)));
    assert.equal(report.orphansRemoved, 1);
  });

  test('logs of deployments that DO exist are kept', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    put(appId, depId, 'build.log', 'keep me');
    await go();
    assert.ok(existsSync(logFilePath(root, appId, depId, 'build')));
  });

  test('a mix: only the orphan goes', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    put(appId, depId, 'build.log', 'keep');
    put(appId, UUID_D, 'build.log', 'orphan');
    await go();
    assert.ok(existsSync(logFilePath(root, appId, depId, 'build')));
    assert.ok(!existsSync(logDirFor(root, appId, UUID_D)));
  });
});

describe('what it must never touch', () => {
  test('anything whose name is not a UUID', async () => {
    mkdirSync(join(root, 'lost+found'));
    writeFileSync(join(root, 'README.txt'), 'hi');
    mkdirSync(join(root, UUID_A, 'not-a-uuid'), { recursive: true });
    writeFileSync(join(root, UUID_A, 'not-a-uuid', 'build.log'), 'x');
    await go();
    assert.ok(existsSync(join(root, 'lost+found')));
    assert.ok(existsSync(join(root, 'README.txt')));
    assert.ok(existsSync(join(root, UUID_A, 'not-a-uuid', 'build.log')));
  });

  test('a directory that is not an app id, even if it holds UUID-named folders, is not touched and does not break the tidy-up', async () => {
    mkdirSync(join(root, 'backup-of-something', UUID_D), { recursive: true });
    writeFileSync(join(root, 'backup-of-something', UUID_D, 'build.log'), 'not ours to judge');
    const report = await go();
    assert.ok(existsSync(join(root, 'backup-of-something', UUID_D, 'build.log')));
    assert.equal(report.orphansRemoved, 0);
  });

  test('a UUID-named directory that holds anything other than our two log files', async () => {
    put(UUID_A, UUID_D, 'build.log', 'ours');
    writeFileSync(join(logDirFor(root, UUID_A, UUID_D), 'precious.db'), 'someone else\'s data');
    await go();
    assert.ok(existsSync(join(logDirFor(root, UUID_A, UUID_D), 'precious.db')));
    assert.ok(existsSync(join(logDirFor(root, UUID_A, UUID_D), 'build.log')));
  });

  test('a missing log directory is simply nothing to do', async () => {
    const report = await reconcileLogs(join(root, 'does-not-exist'), { db: store, log: () => {} });
    assert.deepEqual([report.orphansRemoved, report.logsClosed], [0, 0]);
  });
});
