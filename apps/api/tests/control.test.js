// Stop / start / restart, and what "stopped" means for deployments. The API never touches Docker: it records what the
// administrator wants (apps.desired_state) and queues a job for the worker, which is the only thing with the socket.
import request from 'supertest';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let queue;
let app;
let agent;
let appId;
const ZERO = '00000000-0000-0000-0000-000000000000';

beforeEach(async () => {
  await resetDb();
  queue = { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) };
  app = await makeApp({ queue });
  agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  appId = (await agent.post('/api/apps').send({ name: 'App A', repo: 'o/r', container_port: 3000, host_port: 8080 })).body.id;
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeDb);

const desired = async () => (await testPool.query('SELECT desired_state FROM apps WHERE id = $1', [appId])).rows[0].desired_state;
const controlJobs = () => queue.add.mock.calls.filter(([name]) => name === 'control');

describe('access', () => {
  test.each(['stop', 'start', 'restart'])('%s needs a login', async (action) => {
    const res = await request(app).post(`/api/apps/${appId}/${action}`);
    expect(res.status).toBe(401);
    expect(queue.add).not.toHaveBeenCalled();
    expect(await desired()).toBe('running');
  });

  test.each(['stop', 'start', 'restart'])('%s on an unknown or malformed id is a 404 and queues nothing', async (action) => {
    expect((await agent.post(`/api/apps/${ZERO}/${action}`)).status).toBe(404);
    expect((await agent.post(`/api/apps/not-a-uuid/${action}`)).status).toBe(404);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('recording what the administrator wants', () => {
  test('stop: desired state becomes stopped at once, and a control job is queued for the worker', async () => {
    const res = await agent.post(`/api/apps/${appId}/stop`);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ action: 'stop', desired_state: 'stopped' });
    expect(await desired()).toBe('stopped');
    expect(controlJobs()).toEqual([['control', { appId, action: 'stop' }]]);
  });

  test('start brings a stopped app back to running', async () => {
    await agent.post(`/api/apps/${appId}/stop`);
    const res = await agent.post(`/api/apps/${appId}/start`);
    expect(res.status).toBe(202);
    expect(await desired()).toBe('running');
    expect(controlJobs().at(-1)).toEqual(['control', { appId, action: 'start' }]);
  });

  test('restart of a stopped app starts it: an explicit restart is an explicit start', async () => {
    await agent.post(`/api/apps/${appId}/stop`);
    await agent.post(`/api/apps/${appId}/restart`);
    expect(await desired()).toBe('running');
    expect(controlJobs().at(-1)).toEqual(['control', { appId, action: 'restart' }]);
  });

  test('if the job cannot be queued the request fails and the desired state goes back', async () => {
    queue.add.mockRejectedValue(new Error('redis is down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await agent.post(`/api/apps/${appId}/stop`);
    expect(res.status).toBe(503);
    expect(await desired()).toBe('running');
  });

  test('without a queue the controls are unavailable and nothing changes', async () => {
    const noQueue = request.agent(await makeApp({}));
    await noQueue.post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    const res = await noQueue.post(`/api/apps/${appId}/stop`);
    expect(res.status).toBe(503);
    expect(await desired()).toBe('running');
  });
});

describe('deploying a stopped app', () => {
  beforeEach(async () => { await agent.post(`/api/apps/${appId}/stop`); queue.add.mockClear(); });

  test('is still allowed, and by default does not ask for the app to be started', async () => {
    const res = await agent.post(`/api/apps/${appId}/deployments`);
    expect(res.status).toBe(202);
    const [name, data] = queue.add.mock.calls[0];
    expect(name).toBe('deploy');
    expect(data.startAfterDeploy).toBeFalsy();
    expect(await desired()).toBe('stopped'); // the request itself never flips the state
  });

  test('{ "start": true } is carried to the worker, which applies it only if the deployment succeeds', async () => {
    const res = await agent.post(`/api/apps/${appId}/deployments`).send({ start: true });
    expect(res.status).toBe(202);
    expect(queue.add.mock.calls[0][1].startAfterDeploy).toBe(true);
    expect(await desired()).toBe('stopped');
  });

  test.each([[{ start: 'yes' }], [{ start: 1 }], [{ start: true, extra: 1 }]])('a malformed body %j is refused before anything is queued', async (body) => {
    const res = await agent.post(`/api/apps/${appId}/deployments`).send(body);
    expect(res.status).toBe(400);
    expect(queue.add).not.toHaveBeenCalled();
    expect((await testPool.query('SELECT count(*)::int AS n FROM deployments')).rows[0].n).toBe(0);
  });
});

describe('runtime status in the app views', () => {
  test('is null until the worker has reported something', async () => {
    expect((await agent.get(`/api/apps/${appId}`)).body.runtime).toBeNull();
    expect((await agent.get('/api/apps')).body[0].runtime).toBeNull();
  });

  test('shows what the worker last reported, next to the desired state', async () => {
    await testPool.query(
      `INSERT INTO app_runtime (app_id, state, last_action, last_error) VALUES ($1, 'stopped', 'stop', NULL)`, [appId]);
    await agent.post(`/api/apps/${appId}/start`); // wants running; the worker has not caught up yet
    for (const body of [(await agent.get(`/api/apps/${appId}`)).body, (await agent.get('/api/apps')).body[0]]) {
      expect(body.desired_state).toBe('running');
      expect(body.runtime).toMatchObject({ state: 'stopped', last_action: 'stop', last_error: null });
    }
  });

  test('is removed together with the app row (it is not an orphan table)', async () => {
    await testPool.query(`INSERT INTO app_runtime (app_id, state) VALUES ($1, 'running')`, [appId]);
    await testPool.query('DELETE FROM apps WHERE id = $1', [appId]);
    expect((await testPool.query('SELECT count(*)::int AS n FROM app_runtime')).rows[0].n).toBe(0);
  });
});
