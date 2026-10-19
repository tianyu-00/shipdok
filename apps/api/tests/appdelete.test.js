// Choosing a host port for a new app, and deleting an app. The API never touches Docker: it marks the app and queues a job.
import request from 'supertest';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';
import { parsePortRange, nextFreePort, DEFAULT_PORT_RANGE } from '../src/ports.js';

let queue;
let agent;
const RANGE = { min: 30000, max: 30004 };

async function boot(over = {}) {
  await resetDb();
  let jobs = 0;
  queue = { add: jest.fn(async () => ({ id: String(++jobs) })), remove: jest.fn(async () => {}) };
  agent = request.agent(await makeApp({ queue, portRange: RANGE, ...over }));
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
}
beforeEach(() => boot());
afterAll(closeDb);

let n = 0;
const create = (over = {}) => { n += 1; return agent.post('/api/apps').send({ name: `App ${n}`, repo: 'o/r', container_port: 3000, ...over }); };
const row = async (id) => (await testPool.query('SELECT * FROM apps WHERE id = $1', [id])).rows[0];

describe('the port range setting', () => {
  test('the default is 20000-20999', () => expect(parsePortRange(undefined)).toEqual({ min: 20000, max: 20999 }) && expect(DEFAULT_PORT_RANGE).toBe('20000-20999'));
  test('accepts a range with spaces', () => expect(parsePortRange(' 9000 - 9100 ')).toEqual({ min: 9000, max: 9100 }));
  test('accepts an en or em dash (a range copied from a web page)', () => {
    expect(parsePortRange('20000\u201320999')).toEqual({ min: 20000, max: 20999 });
    expect(parsePortRange('20000\u201420999')).toEqual({ min: 20000, max: 20999 });
  });
  test('accepts a single port and the edges', () => {
    expect(parsePortRange('5000-5000')).toEqual({ min: 5000, max: 5000 });
    expect(parsePortRange('1024-65535')).toEqual({ min: 1024, max: 65535 });
  });
  test.each(['', 'abc', '9000', '9000-', '-9000', '9000-8000', '80-90', '1000-2000', '20000-70000', '1e4-2e4', '9000-9100-9200'])('refuses "%s" with a message', (text) => {
    expect(() => parsePortRange(text)).toThrow(/PORT_RANGE/);
  });
});

describe('choosing a free port', () => {
  test('the lowest one in the range', async () => {
    expect((await create()).body.host_port).toBe(30000);
    expect((await create()).body.host_port).toBe(30001);
  });

  test('skips what apps already have, including gaps, and ports outside the range do not matter', async () => {
    await create({ host_port: 30001 });
    await create({ host_port: 8080 });
    await create({ host_port: 30003 });
    expect(await nextFreePort(testPool, RANGE)).toBe(30000);
    expect((await create()).body.host_port).toBe(30000);
    expect((await create()).body.host_port).toBe(30002);
    expect((await create()).body.host_port).toBe(30004);
  });

  test('a port freed by deleting comes back', async () => {
    const a = await create();
    await create();
    await testPool.query('DELETE FROM apps WHERE id = $1', [a.body.id]);
    expect((await create()).body.host_port).toBe(30000);
  });

  test('a port the user chose is used as given, even inside the range', async () => {
    expect((await create({ host_port: 30002 })).body.host_port).toBe(30002);
  });

  test('a full range is refused with a clear answer and creates nothing', async () => {
    for (let i = 0; i < 5; i += 1) expect((await create()).status).toBe(201);
    const res = await create();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_free_port');
    expect(res.body.error).toMatch(/30000 to 30004/);
    expect((await testPool.query('SELECT count(*)::int AS n FROM apps')).rows[0].n).toBe(5);
  });

  test('a chosen port that is taken is still a conflict, not a silent move', async () => {
    await create({ host_port: 30000 });
    const res = await create({ host_port: 30000 });
    expect(res.status).toBe(409);
  });

  test('creations at the same moment each get their own port', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => create()));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(results.map((r) => r.body.host_port).sort()).toEqual([30000, 30001, 30002, 30003, 30004]);
  });

  test('a range of one port', async () => {
    await boot({ portRange: { min: 31000, max: 31000 } });
    expect((await create()).body.host_port).toBe(31000);
    expect((await create()).status).toBe(409);
  });

  test('still refuses a host port below 1024 when given', async () => {
    expect((await create({ host_port: 80 })).status).toBe(400);
  });
});

describe('deleting an app', () => {
  let id;
  let name;
  beforeEach(async () => {
    const res = await create();
    id = res.body.id;
    name = res.body.name;
  });
  const del = (body = { confirm: name }) => agent.delete(`/api/apps/${id}`).send(body);

  test('marks the app, stops it at once, and queues the job', async () => {
    const res = await del();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ deleting: true });
    expect(queue.add).toHaveBeenCalledWith('deleteapp', { appId: id });
    const r = await row(id);
    expect(r.deleting_at).not.toBeNull();
    expect(r.desired_state).toBe('stopped');
    expect(r.delete_error).toBeNull();
    expect(await row(id)).toBeTruthy(); // nothing is removed by the API itself
  });

  test.each([[{}], [{ confirm: 'wrong name' }], [{ confirm: 'app 1' }], [{ confirm: 5 }], [{ confirm: '' }], [{ confirm: ' App ' }]])('refuses without the exact name: %j', async (body) => {
    const res = await agent.delete(`/api/apps/${id}`).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('confirm_mismatch');
    expect(queue.add).not.toHaveBeenCalled();
    expect((await row(id)).deleting_at).toBeNull();
  });

  test('refuses with no body at all', async () => {
    expect((await agent.delete(`/api/apps/${id}`)).status).toBe(400);
  });

  test('refuses while a deployment is running, and says to cancel it', async () => {
    for (const status of ['queued', 'building', 'starting', 'validating']) {
      const { rows } = await testPool.query(`INSERT INTO deployments (app_id, trigger, status, config_snapshot) VALUES ($1,'manual',$2,'{}') RETURNING id`, [id, status]);
      const res = await del();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('deployment_active');
      await testPool.query('DELETE FROM deployments WHERE id = $1', [rows[0].id]);
    }
    expect(queue.add).not.toHaveBeenCalled();
    expect((await row(id)).deleting_at).toBeNull();
  });

  test('finished deployments do not stand in the way', async () => {
    for (const status of ['successful', 'failed', 'cancelled', 'superseded', 'interrupted']) {
      await testPool.query(`INSERT INTO deployments (app_id, trigger, status, config_snapshot) VALUES ($1,'manual',$2,'{}')`, [id, status]);
    }
    expect((await del()).status).toBe(202);
  });

  test('an unknown or malformed id is a 404', async () => {
    expect((await agent.delete('/api/apps/00000000-0000-4000-8000-000000000000').send({ confirm: 'x' })).status).toBe(404);
    expect((await agent.delete('/api/apps/nope').send({ confirm: 'x' })).status).toBe(404);
  });

  test('needs a login', async () => {
    expect((await request(await makeApp({ queue })).delete(`/api/apps/${id}`).send({ confirm: name })).status).toBe(401);
  });

  test('a failed attempt can be retried: it queues the job again and clears the error', async () => {
    await del();
    await testPool.query(`UPDATE apps SET delete_error = 'a container would not stop' WHERE id = $1`, [id]);
    const first = (await row(id)).deleting_at;
    expect((await del()).status).toBe(202);
    expect(queue.add).toHaveBeenCalledTimes(2);
    const r = await row(id);
    expect(r.delete_error).toBeNull();
    expect(new Date(r.deleting_at).getTime()).toBe(new Date(first).getTime()); // "since when" is not reset
  });

  test('if the job cannot be queued the app is left as it was', async () => {
    await agent.put(`/api/apps/${id}`).send({ memory_mb: 256 });
    await testPool.query(`UPDATE apps SET desired_state = 'running' WHERE id = $1`, [id]);
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    const res = await del();
    expect(res.status).toBe(503);
    const r = await row(id);
    expect(r.deleting_at).toBeNull();
    expect(r.desired_state).toBe('running');
  });

  test('the app list and the app say it is being deleted', async () => {
    await del();
    expect((await agent.get(`/api/apps/${id}`)).body.deleting_at).not.toBeNull();
    expect((await agent.get('/api/apps')).body.find((a) => a.id === id).deleting_at).not.toBeNull();
  });
});

describe('an app that is being deleted accepts nothing new', () => {
  let id;
  beforeEach(async () => {
    const res = await create();
    id = res.body.id;
    await testPool.query(`INSERT INTO deployments (app_id, trigger, status, config_snapshot, image_ref, finished_at) VALUES ($1,'manual','successful','{}','shipdok/x:1', now())`, [id]);
    await agent.delete(`/api/apps/${id}`).send({ confirm: res.body.name });
    queue.add.mockClear();
  });

  test.each([
    ['deploy', (a) => a.post(`/api/apps/${'ID'}/deployments`).send({})],
    ['rollback', (a) => a.post(`/api/apps/${'ID'}/rollback`).send({})],
    ['prune', (a) => a.post(`/api/apps/${'ID'}/prune`).send({})],
    ['start', (a) => a.post(`/api/apps/${'ID'}/start`)],
    ['stop', (a) => a.post(`/api/apps/${'ID'}/stop`)],
    ['restart', (a) => a.post(`/api/apps/${'ID'}/restart`)],
    ['retention', (a) => a.put(`/api/apps/${'ID'}/retention`).send({ auto_prune: true })],
    ['settings', (a) => a.put(`/api/apps/${'ID'}`).send({ memory_mb: 256 })],
  ])('%s is refused with a 409', async (_, call) => {
    const withId = { post: (p, ...r) => agent.post(p.replace('ID', id), ...r) };
    void withId;
    const proxy = new Proxy(agent, { get: (t, k) => (k === 'post' || k === 'put') ? (path) => t[k](path.replace('ID', id)) : t[k] });
    const res = await call(proxy);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('deleting');
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('a webhook push is skipped with the reason', async () => {
    const { createHmac, randomUUID } = await import('node:crypto');
    const payload = JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40), deleted: false, repository: { full_name: 'o/r' } });
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const sig = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    const res = await request(await makeApp({ queue })).post('/api/webhooks/github').set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push').set('X-GitHub-Delivery', randomUUID()).set('X-Hub-Signature-256', sig).send(payload);
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('Every app tracking this branch is being deleted');
    const history = (await agent.get('/api/webhooks/deliveries')).body[0];
    expect(history.details[0]).toMatchObject({ result: 'skipped', reason: 'The app is being deleted' });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
