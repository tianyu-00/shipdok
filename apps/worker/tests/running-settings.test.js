// The administrator can edit an app's settings while it runs. The running container keeps the settings of the deployment that
// created it, so health checks must use THOSE (the newest successful deployment's snapshot), not the edited values.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/db.js';
import { pool, ready, reset, makeApp, makeDeployment } from './helpers.js';

before(ready);
beforeEach(reset);
after(() => pool.end());

const succeed = async (appId, snapshot, status = 'successful') => {
  const id = await makeDeployment(appId, snapshot);
  await pool.query(`UPDATE deployments SET status = $2 WHERE id = $1`, [id, status]);
  return id;
};
const edit = (appId, port, path) => pool.query('UPDATE apps SET container_port = $2, health_path = $3 WHERE id = $1', [appId, port, path]);
const supervised = async (appId) => (await store.listSupervised()).find((a) => a.id === appId);

test('with nothing deployed the app\'s own settings are used', async () => {
  const appId = await makeApp();
  await edit(appId, 4000, '/new');
  assert.deepEqual([(await store.getApp(appId)).container_port, (await store.getApp(appId)).health_path], [4000, '/new']);
  const s = await supervised(appId);
  assert.deepEqual([s.containerPort, s.healthPath], [4000, '/new']);
});

test('after a successful deployment the settings it ran with are used, even if the app was edited since', async () => {
  const appId = await makeApp();
  await succeed(appId, { container_port: 3000, health_path: '/health' });
  await edit(appId, 4000, '/new');
  const app = await store.getApp(appId);
  assert.deepEqual([app.container_port, app.health_path], [3000, '/health']);
  const s = await supervised(appId);
  assert.deepEqual([s.containerPort, s.healthPath], [3000, '/health']);
});

test('only the NEWEST successful deployment counts', async () => {
  const appId = await makeApp();
  await succeed(appId, { container_port: 1111, health_path: '/old' });
  await succeed(appId, { container_port: 2222, health_path: '/mid' });
  const s = await supervised(appId);
  assert.deepEqual([s.containerPort, s.healthPath], [2222, '/mid']);
});

test('a newer deployment that did not succeed is ignored', async () => {
  const appId = await makeApp();
  await succeed(appId, { container_port: 3000, health_path: '/health' });
  await succeed(appId, { container_port: 9999, health_path: '/broken' }, 'failed');
  await succeed(appId, { container_port: 8888, health_path: '/q' }, 'queued');
  const s = await supervised(appId);
  assert.deepEqual([s.containerPort, s.healthPath], [3000, '/health']);
  assert.equal((await store.getApp(appId)).container_port, 3000);
});

test('a running version that had NO health path keeps having none, whatever the app says now', async () => {
  const appId = await makeApp();
  await succeed(appId, { container_port: 3000, health_path: null });
  await edit(appId, 3000, '/added-later');
  assert.equal((await supervised(appId)).healthPath, null);
  assert.equal((await store.getApp(appId)).health_path, null);
});

test('an older record without these keys falls back to the app\'s settings', async () => {
  const appId = await makeApp();
  await succeed(appId, {});
  await edit(appId, 4000, '/x');
  const s = await supervised(appId);
  assert.deepEqual([s.containerPort, s.healthPath], [4000, '/x']);
});

test('other apps\' deployments do not leak in', async () => {
  const a = await makeApp();
  const b = await makeApp();
  await succeed(b, { container_port: 7777, health_path: '/b' });
  await edit(a, 4000, '/a');
  const s = await supervised(a);
  assert.deepEqual([s.containerPort, s.healthPath], [4000, '/a']);
});
