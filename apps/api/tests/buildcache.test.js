// Docker's build cache: the figures the worker left, queueing a clean-up, and building one deployment without the cache.
import request from 'supertest';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let queue;
let agent;

beforeEach(async () => {
  await resetDb();
  await testPool.query('TRUNCATE build_cache');
  queue = { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) };
  agent = request.agent(await makeApp({ queue }));
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
});
afterAll(closeDb);

const row = async () => (await testPool.query('SELECT * FROM build_cache WHERE id = 1')).rows[0];

describe('GET /api/build-cache', () => {
  test('needs a session', async () => {
    expect((await request(await makeApp({ queue })).get('/api/build-cache')).status).toBe(401);
  });

  test('before the worker has measured anything: no figures, nothing running, no last clean-up', async () => {
    const res = await agent.get('/api/build-cache');
    expect([res.status, res.body]).toEqual([200, { totalBytes: null, reclaimableBytes: null, sampledAt: null, cleaning: false, last: null }]);
  });

  test('shows the sample and the last clean-up as numbers', async () => {
    await testPool.query(
      `INSERT INTO build_cache (id, total_bytes, reclaimable_bytes, sampled_at, last_run_at, last_all, last_freed_bytes, last_error)
       VALUES (1, 5000000000, 3000000000, now(), now(), true, 123456789, NULL)`);
    const { body } = await agent.get('/api/build-cache');
    expect([body.totalBytes, body.reclaimableBytes, body.cleaning]).toEqual([5000000000, 3000000000, false]);
    expect(body.last).toMatchObject({ all: true, freedBytes: 123456789, error: null });
    expect(typeof body.sampledAt).toBe('string');
  });

  test('a clean-up that failed shows its reason', async () => {
    await testPool.query(`INSERT INTO build_cache (id, last_run_at, last_all, last_freed_bytes, last_error) VALUES (1, now(), false, 0, 'daemon said no')`);
    expect((await agent.get('/api/build-cache')).body.last).toMatchObject({ freedBytes: 0, error: 'daemon said no' });
  });

  test('"cleaning" is true while one is waiting, and stops being true if it was never reported back (the worker died)', async () => {
    await testPool.query(`INSERT INTO build_cache (id, requested_at) VALUES (1, now())`);
    expect((await agent.get('/api/build-cache')).body.cleaning).toBe(true);
    await testPool.query(`UPDATE build_cache SET requested_at = now() - interval '31 minutes'`);
    expect((await agent.get('/api/build-cache')).body.cleaning).toBe(false);
  });
});

describe('POST /api/build-cache/clean', () => {
  test('needs a session', async () => {
    expect((await request(await makeApp({ queue })).post('/api/build-cache/clean').send({})).status).toBe(401);
  });

  test('queues a clean-up of what has not been used lately by default', async () => {
    const res = await agent.post('/api/build-cache/clean');
    expect([res.status, res.body]).toEqual([202, { queued: true }]);
    expect(queue.add).toHaveBeenCalledWith('cleancache', { all: false });
    expect((await row()).requested_at).not.toBeNull();
    expect((await agent.get('/api/build-cache')).body.cleaning).toBe(true);
  });

  test('{ all: true } asks for everything', async () => {
    await agent.post('/api/build-cache/clean').send({ all: true });
    expect(queue.add).toHaveBeenCalledWith('cleancache', { all: true });
  });

  test('only one at a time: a second request is refused and queues nothing', async () => {
    await agent.post('/api/build-cache/clean');
    const again = await agent.post('/api/build-cache/clean').send({ all: true });
    expect([again.status, again.body.code]).toEqual([409, 'already_queued']);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  test('two requests at the same moment: exactly one is queued', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => agent.post('/api/build-cache/clean')));
    expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409, 409]);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  test('a request that was never reported back does not block for ever', async () => {
    await testPool.query(`INSERT INTO build_cache (id, requested_at) VALUES (1, now() - interval '31 minutes')`);
    expect((await agent.post('/api/build-cache/clean')).status).toBe(202);
  });

  test('once the worker has reported, the next request goes through', async () => {
    await agent.post('/api/build-cache/clean');
    await testPool.query('UPDATE build_cache SET requested_at = NULL');
    expect((await agent.post('/api/build-cache/clean')).status).toBe(202);
  });

  test('anything else in the body is refused', async () => {
    for (const body of [{ all: 'yes' }, { everything: true }]) {
      expect((await agent.post('/api/build-cache/clean').send(body)).status).toBe(400);
    }
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('if the queue is down, the answer says so and a retry is not blocked', async () => {
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    expect((await agent.post('/api/build-cache/clean')).status).toBe(503);
    expect((await row()).requested_at).toBeNull();
    expect((await agent.post('/api/build-cache/clean')).status).toBe(202);
  });
});

describe('deploying without the cache', () => {
  let appId;
  beforeEach(async () => {
    appId = (await agent.post('/api/apps').send({ name: 'App A', repo: 'o/a', container_port: 3000, host_port: 8080 })).body.id;
  });
  const lastJob = () => queue.add.mock.calls.at(-1)[1];

  test('a normal deployment does not ask for it', async () => {
    await agent.post(`/api/apps/${appId}/deployments`);
    expect(lastJob().noCache).toBeUndefined();
  });

  test('noCache: true reaches the worker for that deployment only', async () => {
    expect((await agent.post(`/api/apps/${appId}/deployments`).send({ noCache: true })).status).toBe(202);
    expect(lastJob().noCache).toBe(true);
    await agent.post(`/api/apps/${appId}/deployments`);
    expect(lastJob().noCache).toBeUndefined(); // the next one is normal again
  });

  test('noCache: false is the same as leaving it out; a non-boolean is refused', async () => {
    await agent.post(`/api/apps/${appId}/deployments`).send({ noCache: false });
    expect(lastJob().noCache).toBeUndefined();
    expect((await agent.post(`/api/apps/${appId}/deployments`).send({ noCache: 'yes' })).status).toBe(400);
  });

  test('it is not part of the settings snapshot (it is not a setting of the app)', async () => {
    const res = await agent.post(`/api/apps/${appId}/deployments`).send({ noCache: true });
    expect(res.body.config_snapshot).not.toHaveProperty('noCache');
    expect(res.body.config_snapshot).not.toHaveProperty('no_cache');
  });
});
