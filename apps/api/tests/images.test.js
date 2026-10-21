// Old images of ALL apps: the total a clean-up could free, one button for every app, one switch for the automatic clean-up, and the size at which the
// dashboard says so. The API never touches Docker: it reads the history and queues the same prune job an app's own button queues, once per app.
import request from 'supertest';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let queue;
let agent;
let unauthenticated;
const MB = 1024 * 1024;

beforeEach(async () => {
  await resetDb();
  let jobs = 0;
  queue = { add: jest.fn(async () => ({ id: String(++jobs) })), remove: jest.fn(async () => {}) };
  const app = await makeApp({ queue });
  unauthenticated = request(app);
  agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
});
afterAll(closeDb);

let port = 8100;
const makeAppRow = async (name, over = {}) => (await agent.post('/api/apps').send({ name, repo: `o/${name.toLowerCase()}`, container_port: 3000, host_port: port++, ...over })).body.id;
let n = 0;
async function version(appId, { bytes = 100 * MB, removed = false, image, status = 'successful' } = {}) {
  n += 1;
  const { rows } = await testPool.query(
    `INSERT INTO deployments (app_id, trigger, commit_sha, status, config_snapshot, finished_at) VALUES ($1, 'manual', $2, $3, '{}', now()) RETURNING id`,
    [appId, String(n).padStart(40, 'a'), status]);
  if (status === 'successful') {
    await testPool.query(`UPDATE deployments SET image_ref = $2, image_bytes = $3, image_removed_at = ${removed ? 'now()' : 'NULL'} WHERE id = $1`, [rows[0].id, image ?? `shipdok/x:${rows[0].id}`, bytes]);
  }
  return rows[0].id;
}
const overview = async () => (await agent.get('/api/images')).body;
const jobs = (name) => queue.add.mock.calls.filter(([jobName]) => jobName === name).map(([, data]) => data);

describe('the overview', () => {
  test('needs a session', async () => {
    for (const [method, path] of [['get', '/api/images'], ['post', '/api/images/prune'], ['post', '/api/images/auto-cleanup'], ['put', '/api/images/notice']]) {
      expect([path, (await unauthenticated[method](path).send({})).status]).toEqual([path, 401]);
    }
  });

  test('with no apps: nothing to free, no notice', async () => {
    expect(await overview()).toEqual({ reclaimableBytes: 0, apps: [], autoCleanup: { on: 0, total: 0 }, thresholdBytes: null, exceeded: false });
  });

  test('adds up what each app could free: the live version and the kept earlier ones do not count', async () => {
    const a = await makeAppRow('Alpha');
    for (let i = 0; i < 3; i += 1) await version(a, { bytes: 50 * MB });  // 1 live, 1 kept, 1 old
    const b = await makeAppRow('Beta');   // keeps live + 1
    for (let i = 0; i < 5; i += 1) await version(b, { bytes: 200 * MB }); // 1 live, 1 kept, 3 old
    const o = await overview();
    expect(o.reclaimableBytes).toBe(3 * 200 * MB + 50 * MB);
    // the app with the most to clean comes first, not the first alphabetically
    expect(o.apps.map((x) => [x.name, x.reclaimableBytes, x.images])).toEqual([['Beta', 3 * 200 * MB, 3], ['Alpha', 50 * MB, 1]]);
  });

  test('follows each app\'s own number of kept versions', async () => {
    const a = await makeAppRow('Alpha');
    for (let i = 0; i < 4; i += 1) await version(a, { bytes: 10 * MB });
    expect((await overview()).reclaimableBytes).toBe(2 * 10 * MB);
    await agent.put(`/api/apps/${a}/retention`).send({ keep_previous_images: 3 });
    expect((await overview()).reclaimableBytes).toBe(0);
    await agent.put(`/api/apps/${a}/retention`).send({ keep_previous_images: 0 });
    expect((await overview()).reclaimableBytes).toBe(3 * 10 * MB);
  });

  test('images already removed, failed deployments and one image shared by several deployments are not counted wrongly', async () => {
    const a = await makeAppRow('Alpha');
    await version(a, { bytes: 10 * MB });
    await version(a, { bytes: 10 * MB });
    await version(a, { bytes: 77 * MB, removed: true });
    await version(a, { status: 'failed' });
    await version(a, { bytes: 40 * MB, image: 'shipdok/x:shared' });
    await version(a, { bytes: 40 * MB, image: 'shipdok/x:shared' }); // a rollback reuses the same image: it is one image
    // newest first: the shared image (live), the removed one (ignored), then two 10 MB ones: one kept as the earlier version, one old
    const o = await overview();
    expect([o.reclaimableBytes, o.apps[0].images]).toEqual([10 * MB, 1]);
  });

  test('an app being deleted is not listed', async () => {
    const a = await makeAppRow('Alpha');
    for (let i = 0; i < 4; i += 1) await version(a);
    await testPool.query('UPDATE apps SET deleting_at = now() WHERE id = $1', [a]);
    expect(await overview()).toMatchObject({ reclaimableBytes: 0, apps: [], autoCleanup: { total: 0 } });
  });

  test('says how many apps clean up by themselves', async () => {
    await makeAppRow('Alpha');
    await makeAppRow('Beta', { auto_prune: false });
    expect((await overview()).autoCleanup).toEqual({ on: 1, total: 2 });
  });
});

describe('cleaning every app', () => {
  test('queues one ordinary prune per app, and only for apps that are not being deleted', async () => {
    const a = await makeAppRow('Alpha');
    const b = await makeAppRow('Beta');
    const c = await makeAppRow('Gamma');
    await testPool.query('UPDATE apps SET deleting_at = now() WHERE id = $1', [c]);
    const res = await agent.post('/api/images/prune');
    expect([res.status, res.body]).toEqual([202, { queued: 2, apps: 2 }]);
    expect(jobs('prune').map((j) => j.appId).sort()).toEqual([a, b].sort());
    expect(jobs('prune').every((j) => j.trigger === 'manual')).toBe(true);
  });

  test('with no apps it queues nothing and says so', async () => {
    const res = await agent.post('/api/images/prune');
    expect([res.status, res.body]).toEqual([202, { queued: 0, apps: 0 }]);
  });

  test('when the queue is down: 503, and nothing is claimed', async () => {
    await makeAppRow('Alpha');
    queue.add.mockRejectedValue(new Error('redis down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await agent.post('/api/images/prune');
    expect([res.status, res.body.queued]).toEqual([503, undefined]);
  });

  test('when only some could be queued, it says how many (and does not pretend all were)', async () => {
    await makeAppRow('Alpha');
    await makeAppRow('Beta');
    queue.add.mockResolvedValueOnce({ id: '1' }).mockRejectedValue(new Error('redis down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await agent.post('/api/images/prune');
    expect([res.status, res.body]).toEqual([202, { queued: 1, apps: 2 }]);
  });
});

describe('the automatic clean-up of every app', () => {
  test('switches it on for the apps that do not have it, and says how many changed', async () => {
    const off1 = await makeAppRow('Alpha', { auto_prune: false });
    await makeAppRow('Beta'); // already on
    const off2 = await makeAppRow('Gamma', { auto_prune: false });
    const res = await agent.post('/api/images/auto-cleanup').send({ enabled: true });
    expect([res.status, res.body]).toEqual([200, { enabled: true, changed: 2 }]);
    const { rows } = await testPool.query('SELECT id, auto_prune FROM apps');
    expect(rows.every((r) => r.auto_prune === true)).toBe(true);
    expect([off1, off2].length).toBe(2);
    expect((await overview()).autoCleanup).toEqual({ on: 3, total: 3 });
  });

  test('and off again', async () => {
    await makeAppRow('Alpha');
    await makeAppRow('Beta');
    expect((await agent.post('/api/images/auto-cleanup').send({ enabled: false })).body).toEqual({ enabled: false, changed: 2 });
    expect((await overview()).autoCleanup).toEqual({ on: 0, total: 2 });
  });

  test('an app being deleted is left alone', async () => {
    const a = await makeAppRow('Alpha', { auto_prune: false });
    await testPool.query('UPDATE apps SET deleting_at = now() WHERE id = $1', [a]);
    expect((await agent.post('/api/images/auto-cleanup').send({ enabled: true })).body.changed).toBe(0);
    expect((await testPool.query('SELECT auto_prune FROM apps WHERE id = $1', [a])).rows[0].auto_prune).toBe(false);
  });

  test.each([[{}], [{ enabled: 'yes' }], [{ enabled: 1 }], [{ enabled: true, extra: 1 }]])('refuses %j', async (body) => {
    expect((await agent.post('/api/images/auto-cleanup').send(body)).status).toBe(400);
  });
});

describe('the size at which the dashboard says so', () => {
  const GB = 1024 * MB;
  test('is none (never) until set', async () => {
    expect(await overview()).toMatchObject({ thresholdBytes: null, exceeded: false });
  });

  test('once set it is remembered, and the notice is due when old images reach it (exactly it counts)', async () => {
    const a = await makeAppRow('Alpha');
    for (let i = 0; i < 4; i += 1) await version(a, { bytes: 300 * MB }); // 2 old = 600 MB
    let res = await agent.put('/api/images/notice').send({ thresholdBytes: 601 * MB });
    expect([res.status, res.body.thresholdBytes, res.body.exceeded]).toEqual([200, 601 * MB, false]);
    res = await agent.put('/api/images/notice').send({ thresholdBytes: 600 * MB });
    expect([res.body.thresholdBytes, res.body.exceeded]).toEqual([600 * MB, true]);
    expect(await overview()).toMatchObject({ thresholdBytes: 600 * MB, exceeded: true });
  });

  test('null turns it off again', async () => {
    const a = await makeAppRow('Alpha');
    for (let i = 0; i < 4; i += 1) await version(a, { bytes: 300 * MB });
    await agent.put('/api/images/notice').send({ thresholdBytes: 100 * MB });
    expect((await overview()).exceeded).toBe(true);
    const res = await agent.put('/api/images/notice').send({ thresholdBytes: null });
    expect([res.status, res.body.thresholdBytes, res.body.exceeded]).toEqual([200, null, false]);
    expect((await testPool.query(`SELECT count(*)::int AS n FROM settings WHERE key = 'images_notice_bytes'`)).rows[0].n).toBe(0);
  });

  test('a large size beyond a 32-bit number is kept exactly', async () => {
    expect((await agent.put('/api/images/notice').send({ thresholdBytes: 5 * GB })).body.thresholdBytes).toBe(5 * GB);
  });

  test.each([
    [{}], [{ thresholdBytes: 0 }], [{ thresholdBytes: 100 * MB - 1 }], [{ thresholdBytes: 10 * 1024 ** 4 + 1 }], [{ thresholdBytes: 1.5 * GB + 0.5 }],
    [{ thresholdBytes: '2GB' }], [{ thresholdBytes: -1 }], [{ thresholdBytes: 200 * MB, extra: true }],
  ])('refuses %j', async (body) => {
    expect((await agent.put('/api/images/notice').send(body)).status).toBe(400);
    expect((await overview()).thresholdBytes).toBe(null);
  });

  test('the limits themselves are allowed', async () => {
    expect((await agent.put('/api/images/notice').send({ thresholdBytes: 100 * MB })).status).toBe(200);
    expect((await agent.put('/api/images/notice').send({ thresholdBytes: 10 * 1024 ** 4 })).status).toBe(200);
  });
});
