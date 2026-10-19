// Deleting an app for good. The database and the log directory are real; Docker is a stand-in that records what it is asked.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/db.js';
import { deleteApp, processDeleteJob } from '../src/deleteapp.js';
import { pool, ready, reset, makeApp, makeDeployment, addVar } from './helpers.js';

before(ready);
beforeEach(reset);
after(() => pool.end());

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'delapp-')); });
after(() => rmSync(root, { recursive: true, force: true }));

const noLog = () => {};
const mark = (appId) => pool.query('UPDATE apps SET deleting_at = now() WHERE id = $1', [appId]);
const appExists = async (id) => (await pool.query('SELECT 1 FROM apps WHERE id = $1', [id])).rows.length === 1;
const count = async (sql, id) => (await pool.query(sql, [id])).rows[0].n;
const img = (slug, id) => `shipdok/${slug}:${id}`;

// Docker: `containers` and `images` belong to `appId`; anything else would be another app's and must never be asked about.
function fakeDocker({ appId, containers = ['live', 'candidate'], images = [], failRemove = null, inUse = [], failStop = false } = {}) {
  const events = [];
  const left = new Set(images);
  const eng = {
    events,
    async findAppContainers(id) { events.push(`find ${id === appId ? 'mine' : id}`); return id === appId ? containers.map((name) => ({ name })) : []; },
    async stopContainer(c) { events.push(`stop ${c.name}`); if (failStop) throw new Error('would not stop'); },
    async removeContainerStrict(c) { events.push(`rm ${c.name}`); if (failRemove === c.name) throw new Error('docker said no'); return 'removed'; },
    async listAppImages(id) { events.push(`images ${id === appId ? 'mine' : id}`); return id === appId ? [...left].map((tag) => ({ tag, deploymentId: null, size: 1 })) : []; },
    async removeImageStrict(tag) {
      events.push(`rmi ${tag}`);
      if (inUse.includes(tag)) return 'in-use';
      left.delete(tag); return 'removed';
    },
  };
  return eng;
}

function putLogs(appId, deploymentIds) {
  mkdirSync(join(root, appId), { recursive: true });
  writeFileSync(join(root, appId, 'runtime.log'), 'x'.repeat(10));
  for (const d of deploymentIds) { mkdirSync(join(root, appId, d), { recursive: true }); writeFileSync(join(root, appId, d, 'build.log'), 'y'.repeat(20)); }
}

const run = (appId, eng, extra = {}) => deleteApp({ appId }, { eng, db: store, logRoot: root, log: noLog, ...extra });

describe('what it removes', () => {
  test('containers, images, logs and every record of the app, and nothing of another app', async () => {
    const a = await makeApp();
    const b = await makeApp();
    const d1 = await makeDeployment(a);
    const d2 = await makeDeployment(a);
    const other = await makeDeployment(b);
    await store.markSucceeded(d1, img('app', d1), 10);
    await addVar(a, 'TOKEN', 'v');
    await addVar(b, 'TOKEN', 'v');
    await store.setRuntime(a, { state: 'running', action: 'deploy' });
    await store.openLogFile(a, d1, 'build');
    await pool.query(`DELETE FROM webhook_deliveries WHERE delivery_id = 'delivery-0001'`);
    await pool.query(`INSERT INTO webhook_deliveries (delivery_id, event, outcome) VALUES ('delivery-0001', 'push', 'deployed')`);
    putLogs(a, [d1, d2]);
    putLogs(b, [other]);
    await mark(a);

    const out = await run(a, fakeDocker({ appId: a, images: [img('app', d1), img('app', d2)] }));
    assert.deepEqual([out.containers, out.images, out.logBytes], [2, 2, 10 + 20 + 20]);

    assert.equal(await appExists(a), false);
    assert.equal(await count('SELECT count(*)::int AS n FROM deployments WHERE app_id = $1', a), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM app_env_vars WHERE app_id = $1', a), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM app_runtime WHERE app_id = $1', a), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM log_files WHERE app_id = $1', a), 0);
    assert.ok(!existsSync(join(root, a)));

    assert.equal(await appExists(b), true);
    assert.equal(await count('SELECT count(*)::int AS n FROM deployments WHERE app_id = $1', b), 1);
    assert.equal(await count('SELECT count(*)::int AS n FROM app_env_vars WHERE app_id = $1', b), 1);
    assert.ok(existsSync(join(root, b, 'runtime.log')));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE delivery_id = 'delivery-0001'`)).rows[0].n, 1); // history stays
    await pool.query(`DELETE FROM webhook_deliveries WHERE delivery_id = 'delivery-0001'`);
  });

  test('containers are stopped, then removed, and only this app\'s are asked for', async () => {
    const a = await makeApp();
    await mark(a);
    const eng = fakeDocker({ appId: a });
    await run(a, eng);
    assert.deepEqual(eng.events.filter((e) => /^(find|stop|rm) /.test(e)), ['find mine', 'stop live', 'rm live', 'stop candidate', 'rm candidate']);
  });

  test('a container that will not stop gracefully is still removed (forced)', async () => {
    const a = await makeApp();
    await mark(a);
    const eng = fakeDocker({ appId: a, failStop: true });
    await run(a, eng);
    assert.ok(eng.events.includes('rm live') && eng.events.includes('rm candidate'));
    assert.equal(await appExists(a), false);
  });

  test('only images named the way Shipdok names them are removed', async () => {
    const a = await makeApp();
    await mark(a);
    const d = await makeDeployment(a);
    const eng = fakeDocker({ appId: a, images: [img('app', d), 'shipdok/app:latest', 'nginx:latest', 'shipdok/UPPER:' + d, `shipdok/../x:${d}`] });
    const out = await run(a, eng);
    assert.equal(out.images, 1);
    assert.deepEqual(eng.events.filter((e) => e.startsWith('rmi ')), [`rmi ${img('app', d)}`]);
  });

  test('the output collector lets go of the app BEFORE its log files are removed', async () => {
    const a = await makeApp();
    await mark(a);
    putLogs(a, []);
    const order = [];
    const collector = { release: async (id) => { order.push(['release', id, existsSync(join(root, a))]); } };
    await run(a, fakeDocker({ appId: a }), { collector });
    assert.deepEqual(order, [['release', a, true]]);
    assert.ok(!existsSync(join(root, a)));
  });

  test('an app with nothing deployed (no containers, images or logs) is deleted too', async () => {
    const a = await makeApp();
    await mark(a);
    const out = await run(a, fakeDocker({ appId: a, containers: [] }));
    assert.deepEqual([out.containers, out.images, out.logBytes], [0, 0, 0]);
    assert.equal(await appExists(a), false);
  });
});

describe('what it refuses and what happens on failure', () => {
  test('an app the API did not mark is never touched', async () => {
    const a = await makeApp();
    putLogs(a, []);
    const eng = fakeDocker({ appId: a });
    await assert.rejects(run(a, eng), /not marked/);
    assert.deepEqual(eng.events, []);
    assert.equal(await appExists(a), true);
    assert.ok(existsSync(join(root, a, 'runtime.log')));
  });

  test('an app that is already gone is simply skipped', async () => {
    const out = await run('11111111-1111-4111-8111-111111111111', fakeDocker({ appId: 'x' }));
    assert.deepEqual(out, { ok: true, skipped: true });
  });

  test('a container that cannot be removed: the error is recorded, nothing later is touched, the app stays', async () => {
    const a = await makeApp();
    const d = await makeDeployment(a);
    putLogs(a, [d]);
    await mark(a);
    const eng = fakeDocker({ appId: a, images: [img('app', d)], failRemove: 'live' });
    await assert.rejects(run(a, eng), /docker said no/);
    assert.equal((await pool.query('SELECT delete_error FROM apps WHERE id = $1', [a])).rows[0].delete_error, 'docker said no');
    assert.equal(await appExists(a), true);
    assert.ok(!eng.events.some((e) => e.startsWith('rmi ')));
    assert.ok(existsSync(join(root, a, 'runtime.log')));
  });

  test('an image still in use by a foreign container: recorded, logs and records kept', async () => {
    const a = await makeApp();
    const d = await makeDeployment(a);
    putLogs(a, [d]);
    await mark(a);
    await assert.rejects(run(a, fakeDocker({ appId: a, images: [img('app', d)], inUse: [img('app', d)] })), /still used by a container/);
    assert.match((await pool.query('SELECT delete_error FROM apps WHERE id = $1', [a])).rows[0].delete_error, /still used/);
    assert.equal(await appExists(a), true);
    assert.ok(existsSync(join(root, a, 'runtime.log')));
  });

  test('a retry after a failure finishes the job (every step can be repeated)', async () => {
    const a = await makeApp();
    const d = await makeDeployment(a);
    putLogs(a, [d]);
    await mark(a);
    await assert.rejects(run(a, fakeDocker({ appId: a, images: [img('app', d)], failRemove: 'candidate' })));
    await pool.query('UPDATE apps SET delete_error = NULL WHERE id = $1', [a]); // what the API does on "delete again"
    await run(a, fakeDocker({ appId: a, images: [img('app', d)] }));
    assert.equal(await appExists(a), false);
    assert.ok(!existsSync(join(root, a)));
  });

  test('if the app was un-marked while the job ran, the records are not deleted', async () => {
    const a = await makeApp();
    await mark(a);
    const eng = fakeDocker({ appId: a });
    const original = eng.listAppImages;
    eng.listAppImages = async (id) => { await pool.query('UPDATE apps SET deleting_at = NULL WHERE id = $1', [id]); return original(id); };
    await assert.rejects(run(a, eng), /no longer marked/);
    assert.equal(await appExists(a), true);
  });

  test('the recorded error is short, and only an app that is marked gets one', async () => {
    const a = await makeApp();
    const b = await makeApp();
    await store.setDeleteError(b, 'unmarked');
    assert.equal((await pool.query('SELECT delete_error FROM apps WHERE id = $1', [b])).rows[0].delete_error, null);
    await mark(a);
    await store.setDeleteError(a, 'x'.repeat(2000));
    assert.equal((await pool.query('SELECT length(delete_error)::int AS n FROM apps WHERE id = $1', [a])).rows[0].n, 500);
  });
});

describe('the job', () => {
  test('refuses a payload without a valid app id', async () => {
    await assert.rejects(processDeleteJob({ id: '1', data: {} }), /valid app id/);
    await assert.rejects(processDeleteJob({ id: '1', data: { appId: '../x' } }), /valid app id/);
  });

  test('deletes the marked app it is given', async () => {
    const a = await makeApp();
    await mark(a);
    const out = await processDeleteJob({ id: '7', data: { appId: a }, log: async () => {} }, { eng: fakeDocker({ appId: a, containers: [] }), db: store, logRoot: root });
    assert.equal(out.ok, true);
    assert.equal(await appExists(a), false);
  });
});
