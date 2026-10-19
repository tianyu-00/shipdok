// CPU and memory readings: what the API shows (the worker writes them; the API only reads).
import request from 'supertest';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let agent;
let appId;
let otherId;
const MB = 1024 * 1024;

beforeEach(async () => {
  await resetDb();
  agent = request.agent(await makeApp());
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  appId = (await agent.post('/api/apps').send({ name: 'App A', repo: 'o/a', container_port: 3000, host_port: 8080 })).body.id;
  otherId = (await agent.post('/api/apps').send({ name: 'Other', repo: 'o/b', container_port: 3000, host_port: 8081 })).body.id;
});
afterAll(closeDb);

const sample = (id, secondsAgo, { cpu = 5, mem = 100 * MB, limit = 512 * MB } = {}) =>
  testPool.query(`INSERT INTO app_stats (app_id, sampled_at, cpu_percent, memory_bytes, memory_limit_bytes) VALUES ($1, now() - ($2::int * interval '1 second'), $3, $4, $5)`, [id, secondsAgo, cpu, mem, limit]);

describe('GET /api/apps/:id/stats', () => {
  test('the readings oldest first, and the current one', async () => {
    await sample(appId, 120, { cpu: 1, mem: 10 * MB });
    await sample(appId, 60, { cpu: 2, mem: 20 * MB });
    await sample(appId, 5, { cpu: 3.5, mem: 30 * MB });
    const res = await agent.get(`/api/apps/${appId}/stats`);
    expect(res.status).toBe(200);
    expect(res.body.samples.map((s) => [s.cpu, s.memory])).toEqual([[1, 10 * MB], [2, 20 * MB], [3.5, 30 * MB]]);
    expect(res.body.latest).toMatchObject({ cpuPercent: 3.5, memoryBytes: 30 * MB, memoryLimitBytes: 512 * MB });
    expect(res.body.samples[0].t < res.body.samples[2].t).toBe(true);
  });

  test('only this app\'s readings', async () => {
    await sample(appId, 5, { mem: 1 * MB });
    await sample(otherId, 5, { mem: 999 * MB });
    expect((await agent.get(`/api/apps/${appId}/stats`)).body.samples.map((s) => s.memory)).toEqual([1 * MB]);
  });

  test('a reading without a CPU figure or limit is passed on as null, not as 0', async () => {
    await testPool.query(`INSERT INTO app_stats (app_id, cpu_percent, memory_bytes, memory_limit_bytes) VALUES ($1, NULL, $2, NULL)`, [appId, 7 * MB]);
    const res = await agent.get(`/api/apps/${appId}/stats`);
    expect(res.body.samples[0].cpu).toBeNull();
    expect(res.body.latest).toMatchObject({ cpuPercent: null, memoryBytes: 7 * MB, memoryLimitBytes: null });
  });

  test('"current" is null when the newest reading is old: the app stopped or the worker went quiet; the chart still shows what there was', async () => {
    await sample(appId, 300);
    const res = await agent.get(`/api/apps/${appId}/stats`);
    expect(res.body.latest).toBeNull();
    expect(res.body.samples).toHaveLength(1);
  });

  test('exactly at the edge of "recent"', async () => {
    await sample(appId, 85);
    expect((await agent.get(`/api/apps/${appId}/stats`)).body.latest).not.toBeNull();
    await testPool.query('DELETE FROM app_stats');
    await sample(appId, 95);
    expect((await agent.get(`/api/apps/${appId}/stats`)).body.latest).toBeNull();
  });

  test('?minutes limits how far back it goes', async () => {
    await sample(appId, 20 * 60);
    await sample(appId, 5 * 60);
    await sample(appId, 5);
    expect((await agent.get(`/api/apps/${appId}/stats?minutes=10`)).body.samples).toHaveLength(2);
    expect((await agent.get(`/api/apps/${appId}/stats?minutes=1`)).body.samples).toHaveLength(1);
    expect((await agent.get(`/api/apps/${appId}/stats`)).body.samples).toHaveLength(3);
  });

  test.each(['0', '61', '-5', 'abc', '1.5', '100', ''])('refuses minutes=%s', async (m) => {
    expect((await agent.get(`/api/apps/${appId}/stats?minutes=${m}`)).status).toBe(400);
  });

  test('an app with no readings: empty, not an error', async () => {
    const res = await agent.get(`/api/apps/${appId}/stats`);
    expect(res.body).toEqual({ latest: null, samples: [] });
  });

  test('unknown or malformed id is a 404', async () => {
    expect((await agent.get('/api/apps/00000000-0000-4000-8000-000000000000/stats')).status).toBe(404);
    expect((await agent.get('/api/apps/nope/stats')).status).toBe(404);
  });

  test('needs a login', async () => {
    expect((await request(await makeApp()).get(`/api/apps/${appId}/stats`)).status).toBe(401);
  });
});

describe('the current reading on the app and in the list', () => {
  test('is there when recent, shaped the same way', async () => {
    await sample(appId, 5, { cpu: 12, mem: 64 * MB });
    const detail = (await agent.get(`/api/apps/${appId}`)).body;
    expect(detail.stats).toMatchObject({ cpuPercent: 12, memoryBytes: 64 * MB, memoryLimitBytes: 512 * MB });
    const listed = (await agent.get('/api/apps')).body;
    expect(listed.find((a) => a.id === appId).stats.memoryBytes).toBe(64 * MB);
    expect(listed.find((a) => a.id === otherId).stats).toBeNull();
  });

  test('is null when old', async () => {
    await sample(appId, 600);
    expect((await agent.get(`/api/apps/${appId}`)).body.stats).toBeNull();
    expect((await agent.get('/api/apps')).body.find((a) => a.id === appId).stats).toBeNull();
  });

  test('uses the newest reading when there are several recent ones', async () => {
    await sample(appId, 40, { mem: 1 * MB });
    await sample(appId, 10, { mem: 2 * MB });
    expect((await agent.get(`/api/apps/${appId}`)).body.stats.memoryBytes).toBe(2 * MB);
  });

  test('a settings edit still returns the current reading', async () => {
    await sample(appId, 5, { mem: 3 * MB });
    expect((await agent.put(`/api/apps/${appId}`).send({ memory_mb: 256 })).body.stats.memoryBytes).toBe(3 * MB);
  });
});
