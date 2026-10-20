// What the API shows about crashes and health. The worker writes these rows; the API only reads them.
import request from 'supertest';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let app;
let agent;
let appId;
const ZERO = '00000000-0000-0000-0000-000000000000';
const VALID = { name: 'App A', repo: 'o/r', container_port: 3000, host_port: 8080 };

beforeEach(async () => {
  await resetDb();
  app = await makeApp({ queue: { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) } });
  agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  appId = (await agent.post('/api/apps').send(VALID)).body.id;
});
afterAll(closeDb);

const crash = (over = {}) => testPool.query(
  `INSERT INTO app_crash_events (app_id, occurred_at, cause, exit_code, oom_killed, action)
   VALUES ($1, $2, $3, $4, $5, $6)`,
  [appId, over.at ?? new Date(), over.cause ?? 'crash', over.exit ?? 1, over.oom ?? false, over.action ?? 'restart_scheduled']);

describe('max_restarts', () => {
  test('defaults to 5 and can be set when the app is created', async () => {
    expect((await agent.get(`/api/apps/${appId}`)).body.max_restarts).toBe(5);
    const res = await agent.post('/api/apps').send({ ...VALID, name: 'App B', host_port: 8081, max_restarts: 2 });
    expect(res.status).toBe(201);
    expect(res.body.max_restarts).toBe(2);
  });

  test.each([[-1], [51], [1.5], ['5']])('%j is refused', async (value) => {
    const res = await agent.post('/api/apps').send({ ...VALID, name: 'App C', host_port: 8082, max_restarts: value });
    expect(res.status).toBe(400);
  });

  test('0 is allowed: never restart automatically', async () => {
    const res = await agent.post('/api/apps').send({ ...VALID, name: 'App D', host_port: 8083, max_restarts: 0 });
    expect(res.status).toBe(201);
  });
});

describe('runtime details', () => {
  test('the app views show the crash and health fields the worker recorded', async () => {
    await testPool.query(
      `INSERT INTO app_runtime (app_id, state, last_action, last_error, last_exit_code, oom_killed, health_failures, next_restart_at)
       VALUES ($1, 'restarting', 'auto_restart', 'Exited with code 137', 137, true, 2, now() + interval '30 seconds')`, [appId]);
    for (const body of [(await agent.get(`/api/apps/${appId}`)).body, (await agent.get('/api/apps')).body[0]]) {
      expect(body.runtime).toMatchObject({
        state: 'restarting', last_action: 'auto_restart', last_exit_code: 137, oom_killed: true, health_failures: 2,
      });
      expect(body.runtime.next_restart_at).toEqual(expect.any(String));
    }
  });

  test('a container removed outside Shipdok is shown as missing, and the history says so', async () => {
    await testPool.query(
      `INSERT INTO app_runtime (app_id, state, last_error) VALUES ($1, 'missing', 'The container was removed outside Shipdok')`, [appId]);
    await testPool.query(`INSERT INTO app_crash_events (app_id, cause, action) VALUES ($1, 'removed_outside', 'none')`, [appId]);
    expect((await agent.get(`/api/apps/${appId}`)).body.runtime).toMatchObject({ state: 'missing' });
    expect((await agent.get(`/api/apps/${appId}/crashes`)).body[0]).toMatchObject({ cause: 'removed_outside', exit_code: null, action: 'none' });
  });

  test('internal bookkeeping columns are not exposed', async () => {
    await testPool.query(`INSERT INTO app_runtime (app_id, state, last_death_at, crash_reset_at) VALUES ($1, 'running', now(), now())`, [appId]);
    const { runtime } = (await agent.get(`/api/apps/${appId}`)).body;
    expect(runtime).not.toHaveProperty('last_death_at');
    expect(runtime).not.toHaveProperty('crash_reset_at');
  });
});

describe('GET /api/apps/:id/crashes', () => {
  test('needs a login', async () => {
    expect((await request(app).get(`/api/apps/${appId}/crashes`)).status).toBe(401);
  });

  test('unknown or malformed ids are a 404', async () => {
    expect((await agent.get(`/api/apps/${ZERO}/crashes`)).status).toBe(404);
    expect((await agent.get('/api/apps/not-a-uuid/crashes')).status).toBe(404);
  });

  test('is an empty list for an app that never crashed', async () => {
    const res = await agent.get(`/api/apps/${appId}/crashes`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('lists the newest 20 events first, with what happened and what Shipdok did about it', async () => {
    for (let i = 0; i < 25; i++) await crash({ at: new Date(Date.UTC(2026, 9, 18, 12, i)), exit: i });
    await crash({ at: new Date(Date.UTC(2026, 9, 18, 13, 0)), cause: 'stopped_outside', exit: 137, action: 'none' });
    const { body } = await agent.get(`/api/apps/${appId}/crashes`);
    expect(body).toHaveLength(20);
    expect(body[0]).toMatchObject({ cause: 'stopped_outside', exit_code: 137, oom_killed: false, action: 'none' });
    expect(body[1]).toMatchObject({ cause: 'crash', exit_code: 24 });
    expect(new Date(body[0].occurred_at) > new Date(body[1].occurred_at)).toBe(true);
    expect(body[0]).not.toHaveProperty('app_id');
  });

  test('only shows this app\'s events', async () => {
    const other = (await agent.post('/api/apps').send({ ...VALID, name: 'Other', host_port: 8090 })).body.id;
    await testPool.query(`INSERT INTO app_crash_events (app_id, cause, action) VALUES ($1, 'crash', 'gave_up')`, [other]);
    expect((await agent.get(`/api/apps/${appId}/crashes`)).body).toEqual([]);
  });
});
