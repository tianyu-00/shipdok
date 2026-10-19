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

describe('runtime logs a dead worker left open', () => {
  test('are closed with the size of THEIR file, and the previous run\'s record is left alone', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    put(appId, depId, 'runtime.log', 'r'.repeat(321));
    put(appId, depId, 'runtime.previous.log', 'p'.repeat(99));
    await pool.query(`INSERT INTO log_files (deployment_id, app_id, kind) VALUES ($1, $2, 'runtime')`, [depId, appId]);
    await pool.query(`INSERT INTO log_files (deployment_id, app_id, kind, bytes, ended_at) VALUES ($1, $2, 'runtime_previous', 99, now())`, [depId, appId]);
    await go();
    const rows = Object.fromEntries((await pool.query('SELECT kind, bytes, ended_at FROM log_files WHERE deployment_id = $1', [depId])).rows.map((r) => [r.kind, r]));
    assert.equal(Number(rows.runtime.bytes), 321);
    assert.notEqual(rows.runtime.ended_at, null);
    assert.equal(Number(rows.runtime_previous.bytes), 99);
  });

  test('a log that had been cut short at the size cap is still marked cut short after it is closed', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    put(appId, depId, 'runtime.log', 'r'.repeat(50));
    await pool.query(`INSERT INTO log_files (deployment_id, app_id, kind, truncated) VALUES ($1, $2, 'runtime', true)`, [depId, appId]);
    await go();
    const r = (await pool.query(`SELECT truncated, ended_at FROM log_files WHERE deployment_id = $1 AND kind = 'runtime'`, [depId])).rows[0];
    assert.deepEqual([r.truncated, r.ended_at !== null], [true, true]);
  });

  test('a deployment\'s directory holding runtime.previous.log counts as ours when it is tidied away', async () => {
    put(UUID_A, UUID_D, 'runtime.log', 'x');
    put(UUID_A, UUID_D, 'runtime.previous.log', 'y');
    await go();
    assert.ok(!existsSync(logDirFor(root, UUID_A, UUID_D)));
  });
});

describe('logs of deployments that no longer exist', () => {
  test('are removed, and the app directory with them when it is empty', async () => {
    put(UUID_A, UUID_D, 'build.log', 'orphan');
    put(UUID_A, UUID_D, 'runtime.log', 'orphan too');
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
