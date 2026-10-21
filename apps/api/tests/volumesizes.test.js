// How big the persistent volumes are: measured when the administrator asks (the worker does the measuring, the API records the request and shows
// the last figures), and where the figures appear.
import request from 'supertest';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let queue;
let agent;
let appId;

beforeEach(async () => {
  await resetDb();
  await testPool.query('TRUNCATE app_volumes, volume_sizing');
  queue = { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) };
  agent = request.agent(await makeApp({ queue }));
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  appId = (await agent.post('/api/apps').send({ name: 'App A', repo: 'o/a', container_port: 3000, host_port: 8080 })).body.id;
});
afterAll(closeDb);

const sizing = async () => (await testPool.query('SELECT * FROM volume_sizing WHERE id = 1')).rows[0];
let n = 0;
const volume = (over = {}) => {
  n += 1;
  const v = { app_id: appId, app_name: 'App A', path: `/data${n}`, name: `shipdok-vol-${n}`, state: 'in_use', size: null, measured: false, ...over };
  return testPool.query(
    `INSERT INTO app_volumes (app_id, app_name, container_path, docker_name, state, size_bytes, measured_at) VALUES ($1, $2, $3, $4, $5, $6, ${v.measured ? 'now()' : 'NULL'})`,
    [v.app_id, v.app_name, v.path, v.name, v.state, v.size]);
};

describe('asking for a measurement (POST /api/volumes/sizes)', () => {
  test('needs a session', async () => {
    expect((await request(await makeApp({ queue })).post('/api/volumes/sizes')).status).toBe(401);
  });

  test('is accepted, and the request is recorded for the worker (no job on the deployment queue: a slow measurement must not hold a deployment up)', async () => {
    const res = await agent.post('/api/volumes/sizes');
    expect([res.status, res.body]).toEqual([202, { queued: true }]);
    expect((await sizing()).requested_at).not.toBeNull();
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('a second ask while the first waits is refused, so two cannot run at once', async () => {
    await agent.post('/api/volumes/sizes');
    const res = await agent.post('/api/volumes/sizes');
    expect([res.status, res.body.code]).toEqual([409, 'already_measuring']);
  });

  test('once the worker has finished (it clears the request) a new one is accepted', async () => {
    await agent.post('/api/volumes/sizes');
    await testPool.query('UPDATE volume_sizing SET requested_at = NULL, finished_at = now()');
    expect((await agent.post('/api/volumes/sizes')).status).toBe(202);
  });

  test('a request nobody answered for half an hour (the worker died) stops blocking', async () => {
    await testPool.query(`INSERT INTO volume_sizing (id, requested_at) VALUES (1, now() - interval '31 minutes')`);
    expect((await agent.post('/api/volumes/sizes')).status).toBe(202);
    await testPool.query(`UPDATE volume_sizing SET requested_at = now() - interval '29 minutes'`);
    expect((await agent.post('/api/volumes/sizes')).status).toBe(409);
  });

  test('it does not clash with deleting a volume: that route is unchanged', async () => {
    expect((await agent.delete('/api/volumes/sizes')).status).toBe(404);
  });
});

describe('how it stands (GET /api/volumes/sizes)', () => {
  test('needs a session', async () => {
    expect((await request(await makeApp({ queue })).get('/api/volumes/sizes')).status).toBe(401);
  });

  test('before anything: nothing measured, nothing running', async () => {
    const res = await agent.get('/api/volumes/sizes');
    expect([res.status, res.body]).toEqual([200, { measuring: false, finishedAt: null, error: null, totalBytes: 0, measured: 0 }]);
  });

  test('while a measurement waits or runs it says so', async () => {
    await agent.post('/api/volumes/sizes');
    expect((await agent.get('/api/volumes/sizes')).body.measuring).toBe(true);
  });

  test('a request nobody answered for half an hour is no longer "measuring"', async () => {
    await testPool.query(`INSERT INTO volume_sizing (id, requested_at) VALUES (1, now() - interval '31 minutes')`);
    expect((await agent.get('/api/volumes/sizes')).body.measuring).toBe(false);
  });

  test('after the worker: when it finished, the total, and how many volumes have a figure', async () => {
    await volume({ size: 1000, measured: true });
    await volume({ size: 500, measured: true, state: 'detached' });
    await volume({ size: null, measured: true }); // Docker had none yet
    await volume(); // never measured
    await testPool.query('INSERT INTO volume_sizing (id, finished_at) VALUES (1, now())');
    const { body } = await agent.get('/api/volumes/sizes');
    expect([body.totalBytes, body.measured, body.measuring, body.error]).toEqual([1500, 2, false, null]);
    expect(typeof body.finishedAt).toBe('string');
  });

  test('a failure is shown with its plain reason', async () => {
    await testPool.query(`INSERT INTO volume_sizing (id, finished_at, last_error) VALUES (1, now(), 'Docker could not measure the volumes')`);
    expect((await agent.get('/api/volumes/sizes')).body.error).toBe('Docker could not measure the volumes');
  });

  test('sizes are numbers, also large ones (a terabyte)', async () => {
    await volume({ size: 1_099_511_627_776, measured: true });
    const { body } = await agent.get('/api/volumes/sizes');
    expect(body.totalBytes).toBe(1_099_511_627_776);
  });
});

describe('where the sizes appear', () => {
  test('an app\'s volumes carry their size and when it was measured (null before)', async () => {
    await volume({ path: '/a', size: 2048, measured: true });
    await volume({ path: '/b' });
    const { body } = await agent.get(`/api/apps/${appId}/volumes`);
    const [a, b] = body.volumes;
    expect([a.path, a.sizeBytes, typeof a.measuredAt]).toEqual(['/a', 2048, 'string']);
    expect([b.path, b.sizeBytes, b.measuredAt]).toEqual(['/b', null, null]);
  });

  test('saving the paths answers with the sizes too', async () => {
    await volume({ path: '/data', size: 77, measured: true });
    const res = await agent.put(`/api/apps/${appId}/volumes`).send({ paths: ['/data'] });
    expect(res.body.volumes.find((v) => v.path === '/data').sizeBytes).toBe(77);
  });

  test('the volumes kept without an app carry them', async () => {
    await volume({ app_id: null, app_name: 'Gone', path: '/old', state: 'orphaned', size: 4096, measured: true });
    const { body } = await agent.get('/api/volumes');
    expect(body.volumes[0]).toMatchObject({ path: '/old', sizeBytes: 4096 });
  });

  test('the storage page: per app how many volumes, how many are measured, and their bytes; the total includes volumes whose app is gone', async () => {
    await volume({ size: 1000, measured: true });
    await volume({ size: 200, measured: true, state: 'detached' });
    await volume(); // not measured
    await volume({ app_id: null, app_name: 'Gone', state: 'orphaned', size: 50, measured: true });
    const { body } = await agent.get('/api/storage');
    expect(body.volumes.apps).toEqual([{ appId, slug: 'app-a', count: 3, measured: 2, bytes: 1200 }]);
    expect(body.volumes.totalBytes).toBe(1250);
    expect(typeof body.volumes.measuredAt).toBe('string');
  });

  test('the storage page before any measurement: nothing known, nothing invented', async () => {
    await volume();
    const { body } = await agent.get('/api/storage');
    expect(body.volumes).toMatchObject({ totalBytes: 0, measuredAt: null, apps: [{ count: 1, measured: 0, bytes: 0 }] });
  });

  test('the storage page with no volumes at all', async () => {
    const { body } = await agent.get('/api/storage');
    expect(body.volumes).toEqual({ totalBytes: 0, measuredAt: null, apps: [] });
  });

  test('no size ever contains a path or name from Docker beyond what Shipdok already shows', async () => {
    await volume({ size: 1, measured: true });
    expect(JSON.stringify((await agent.get('/api/volumes/sizes')).body)).not.toMatch(/shipdok-vol|\/data/);
  });
});
