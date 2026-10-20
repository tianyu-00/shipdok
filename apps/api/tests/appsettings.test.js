// Editing an app's settings. The repository and the slug (it names the images) never change; a host port can only move to one
// no other app has; and an edit never touches what is running: it is "pending" until the next deployment.
import request from 'supertest';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let queue;
let agent;
let appId;
let otherId;

beforeEach(async () => {
  await resetDb();
  queue = { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) };
  agent = request.agent(await makeApp({ queue }));
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  appId = (await agent.post('/api/apps').send({ name: 'App A', repo: 'o/a', container_port: 3000, host_port: 8080, health_path: '/health' })).body.id;
  otherId = (await agent.post('/api/apps').send({ name: 'Other', repo: 'o/b', container_port: 3000, host_port: 8081 })).body.id;
});
afterAll(closeDb);

const put = (id, body) => agent.put(`/api/apps/${id}`).send(body);
const row = async (id) => (await testPool.query('SELECT * FROM apps WHERE id = $1', [id])).rows[0];
const deployed = (id, snapshot) => testPool.query(`INSERT INTO deployments (app_id, trigger, status, config_snapshot, finished_at) VALUES ($1,'manual','successful',$2, now())`, [id, snapshot]);

describe('what can be edited', () => {
  test('every setting, and the answer is the updated app', async () => {
    const res = await put(appId, { name: 'Renamed', branch: 'release', root_dir: 'web', container_port: 4000, host_port: 9000, health_path: '/up', memory_mb: 1024, cpus: 2, max_restarts: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: appId, name: 'Renamed', branch: 'release', root_dir: 'web', container_port: 4000, host_port: 9000, health_path: '/up', memory_mb: 1024, max_restarts: 0 });
    expect(Number(res.body.cpus)).toBe(2);
    const r = await row(appId);
    expect([r.name, r.branch, r.root_dir, r.container_port, r.host_port, r.health_path, r.memory_mb, r.max_restarts]).toEqual(['Renamed', 'release', 'web', 4000, 9000, '/up', 1024, 0]);
  });

  test('only what is sent changes', async () => {
    await put(appId, { memory_mb: 256 });
    const r = await row(appId);
    expect([r.name, r.branch, r.host_port, r.health_path, r.memory_mb]).toEqual(['App A', 'main', 8080, '/health', 256]);
  });

  test('the health check can be turned off with null', async () => {
    expect((await put(appId, { health_path: null })).status).toBe(200);
    expect((await row(appId)).health_path).toBeNull();
  });

  test('the slug stays, so existing images and containers keep their names', async () => {
    const before = (await row(appId)).slug;
    await put(appId, { name: 'Completely Different' });
    expect((await row(appId)).slug).toBe(before);
  });

  test.each([
    ['repo', { repo: 'o/other' }],
    ['slug', { slug: 'x' }],
    ['id', { id: '00000000-0000-0000-0000-000000000000' }],
    ['desired_state', { desired_state: 'stopped' }],
    ['keep_previous_images', { keep_previous_images: 3 }],
    ['an unknown field', { colour: 'red' }],
    ['a forbidden field next to a valid one', { repo: 'o/other', memory_mb: 256 }],
  ])('refuses %s', async (_, body) => {
    const res = await put(appId, body);
    expect(res.status).toBe(400);
    expect((await row(appId)).repo).toBe('o/a');
    expect((await row(appId)).memory_mb).toBe(512);
  });

  test('refuses an empty request', async () => {
    expect((await put(appId, {})).status).toBe(400);
  });

  test.each([
    [{ branch: '..bad' }], [{ branch: '' }], [{ root_dir: '../x' }], [{ root_dir: '/abs' }], [{ container_port: 0 }], [{ container_port: 70000 }],
    [{ host_port: 80 }], [{ host_port: 70000 }], [{ host_port: 'x' }], [{ health_path: 'no-slash' }], [{ health_path: '/has space' }],
    [{ memory_mb: 10 }], [{ memory_mb: 99999 }], [{ cpus: 0 }], [{ cpus: 9 }], [{ max_restarts: -1 }], [{ max_restarts: 51 }], [{ name: '' }], [{ name: '!!!' }],
    [{ build_timeout_minutes: 4 }], [{ build_timeout_minutes: 0 }], [{ build_timeout_minutes: -5 }], [{ build_timeout_minutes: 10081 }], [{ build_timeout_minutes: 5.5 }], [{ build_timeout_minutes: '30' }],
  ])('refuses %j the way creating does', async (body) => {
    const before = await row(appId);
    const res = await put(appId, body);
    expect(res.status).toBe(400);
    expect(await row(appId)).toEqual(before);
  });

  test('one bad field means nothing is changed', async () => {
    const res = await put(appId, { memory_mb: 256, host_port: 80 });
    expect(res.status).toBe(400);
    expect((await row(appId)).memory_mb).toBe(512);
  });

  test('an unknown or malformed id is a 404', async () => {
    expect((await put('00000000-0000-4000-8000-000000000000', { memory_mb: 256 })).status).toBe(404);
    expect((await put('nope', { memory_mb: 256 })).status).toBe(404);
  });

  test('needs a login', async () => {
    expect((await request(await makeApp({ queue })).put(`/api/apps/${appId}`).send({ memory_mb: 256 })).status).toBe(401);
  });
});

describe('ports and names that are taken', () => {
  test('a port another app uses is refused, and the answer names that app', async () => {
    const res = await put(appId, { host_port: 8081 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'port_taken', app: { id: otherId, name: 'Other' } });
    expect(res.body.error).toMatch(/8081/);
    expect(res.body.error).toMatch(/Other/);
    expect((await row(appId)).host_port).toBe(8080);
  });

  test('keeping its own port is fine', async () => {
    expect((await put(appId, { host_port: 8080, memory_mb: 300 })).status).toBe(200);
  });

  test('a freed port can be taken by another app', async () => {
    expect((await put(otherId, { host_port: 9100 })).status).toBe(200);
    expect((await put(appId, { host_port: 8081 })).status).toBe(200);
  });

  test('swapping ports in two steps works', async () => {
    expect((await put(appId, { host_port: 7000 })).status).toBe(200);
    expect((await put(otherId, { host_port: 8080 })).status).toBe(200);
    expect((await put(appId, { host_port: 8081 })).status).toBe(200);
  });

  test('a name another app has is refused', async () => {
    const res = await put(appId, { name: 'Other' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('name_taken');
    expect((await row(appId)).name).toBe('App A');
  });

  test('keeping its own name is fine', async () => {
    expect((await put(appId, { name: 'App A', memory_mb: 300 })).status).toBe(200);
  });

  test('two edits racing for the same free port: exactly one wins', async () => {
    const results = await Promise.all([put(appId, { host_port: 9500 }), put(otherId, { host_port: 9500 })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(loser.body.code).toBe('port_taken');
  });
});

describe('what is running is not touched', () => {
  test('an edit creates no deployment and queues nothing', async () => {
    await put(appId, { host_port: 9000, memory_mb: 256 });
    expect(queue.add).not.toHaveBeenCalled();
    expect((await testPool.query('SELECT count(*)::int AS n FROM deployments')).rows[0].n).toBe(0);
  });

  test('with nothing deployed yet there is nothing pending', async () => {
    const res = await put(appId, { memory_mb: 256 });
    expect(res.body.settings_pending).toBeNull();
  });

  test('settings that differ from the running deployment are listed as pending', async () => {
    await deployed(appId, { repo: 'o/a', branch: 'main', root_dir: '.', container_port: 3000, host_port: 8080, health_path: '/health', memory_mb: 512, cpus: 1 });
    expect((await agent.get(`/api/apps/${appId}`)).body.settings_pending).toEqual([]);
    const res = await put(appId, { host_port: 9000, memory_mb: 1024, cpus: 2, health_path: null, branch: 'dev', root_dir: 'web', container_port: 4000 });
    expect(res.body.settings_pending.sort()).toEqual(['branch', 'container_port', 'cpus', 'health_path', 'host_port', 'memory_mb', 'root_dir']);
    expect((await agent.get(`/api/apps/${appId}`)).body.settings_pending.length).toBe(7);
  });

  test('putting a value back clears it from the pending list', async () => {
    await deployed(appId, { repo: 'o/a', branch: 'main', root_dir: '.', container_port: 3000, host_port: 8080, health_path: '/health', memory_mb: 512, cpus: 1 });
    await put(appId, { memory_mb: 1024 });
    expect((await agent.get(`/api/apps/${appId}`)).body.settings_pending).toEqual(['memory_mb']);
    await put(appId, { memory_mb: 512 });
    expect((await agent.get(`/api/apps/${appId}`)).body.settings_pending).toEqual([]);
  });

  test('the name and the restart limit are never pending: they apply at once', async () => {
    await deployed(appId, { repo: 'o/a', branch: 'main', root_dir: '.', container_port: 3000, host_port: 8080, health_path: '/health', memory_mb: 512, cpus: 1 });
    const res = await put(appId, { name: 'New name', max_restarts: 1 });
    expect(res.body.settings_pending).toEqual([]);
  });

  test('only the newest successful deployment is compared', async () => {
    await deployed(appId, { branch: 'main', root_dir: '.', container_port: 3000, host_port: 1111, health_path: '/health', memory_mb: 512, cpus: 1 });
    await deployed(appId, { branch: 'main', root_dir: '.', container_port: 3000, host_port: 8080, health_path: '/health', memory_mb: 512, cpus: 1 });
    await testPool.query(`INSERT INTO deployments (app_id, trigger, status, config_snapshot) VALUES ($1,'manual','failed','{"host_port":5555}')`, [appId]);
    expect((await agent.get(`/api/apps/${appId}`)).body.settings_pending).toEqual([]);
  });

  test('the running settings are the deployed ones, without variable versions, on the app and in the list', async () => {
    await deployed(appId, { repo: 'o/a', branch: 'main', root_dir: '.', container_port: 3000, host_port: 8080, health_path: '/health', memory_mb: 512, cpus: 1, env: { SECRET_NAME: '1' } });
    await put(appId, { host_port: 9000 });
    const detail = (await agent.get(`/api/apps/${appId}`)).body;
    expect(detail.host_port).toBe(9000);
    expect(detail.running_settings).toMatchObject({ host_port: 8080, memory_mb: 512 });
    expect(detail.running_settings).not.toHaveProperty('env');
    const listed = (await agent.get('/api/apps')).body.find((a) => a.id === appId);
    expect(listed.running_settings.host_port).toBe(8080);
    expect((await agent.get('/api/apps')).body.find((a) => a.id === otherId).running_settings).toBeNull();
  });

  test('a record without a setting counts as unchanged, not as pending', async () => {
    await deployed(appId, {});
    expect((await agent.get(`/api/apps/${appId}`)).body.settings_pending).toEqual([]);
  });
});

describe('the build time limit', () => {
  test('a new app has no limit', async () => {
    expect((await agent.get(`/api/apps/${appId}`)).body.build_timeout_minutes).toBeNull();
  });

  test('can be set (5 minutes to 7 days) and cleared again (null = no limit)', async () => {
    for (const minutes of [5, 45, 10080]) {
      const res = await put(appId, { build_timeout_minutes: minutes });
      expect([minutes, res.status, res.body.build_timeout_minutes]).toEqual([minutes, 200, minutes]);
      expect((await row(appId)).build_timeout_minutes).toBe(minutes);
    }
    const cleared = await put(appId, { build_timeout_minutes: null });
    expect([cleared.status, cleared.body.build_timeout_minutes]).toEqual([200, null]);
    expect((await row(appId)).build_timeout_minutes).toBeNull();
  });

  test('is a setting that waits for the next deployment, like the other build settings', async () => {
    await deployed(appId, { repo: 'o/a', branch: 'main', root_dir: '.', container_port: 3000, host_port: 8080, health_path: '/health', memory_mb: 512, cpus: 1, build_timeout_minutes: null });
    expect((await agent.get(`/api/apps/${appId}`)).body.settings_pending).toEqual([]);
    expect((await put(appId, { build_timeout_minutes: 60 })).body.settings_pending).toEqual(['build_timeout_minutes']);
    expect((await put(appId, { build_timeout_minutes: null })).body.settings_pending).toEqual([]);
  });
});
