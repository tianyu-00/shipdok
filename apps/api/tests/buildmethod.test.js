// How an app's image is made: its own Dockerfile (the default) or Railpack, with an install, a build and a start command that Railpack may be given.
import request from 'supertest';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let queue;
let agent;
const BASE = { name: 'Site', repo: 'o/site', container_port: 3000, host_port: 8080 };

beforeEach(async () => {
  await resetDb();
  queue = { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) };
  agent = request.agent(await makeApp({ queue }));
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
});
afterAll(closeDb);

const create = (over = {}) => agent.post('/api/apps').send({ ...BASE, ...over });
const put = (id, body) => agent.put(`/api/apps/${id}`).send(body);
const row = async (id) => (await testPool.query('SELECT build_method, install_command, build_command, start_command FROM apps WHERE id = $1', [id])).rows[0];
const lastJob = () => queue.add.mock.calls.at(-1)[1];

describe('creating', () => {
  test('an app uses its Dockerfile unless told otherwise, with no commands', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ build_method: 'dockerfile', install_command: null, build_command: null, start_command: null });
  });

  test('Railpack with its three commands', async () => {
    const res = await create({ build_method: 'railpack', install_command: 'npm ci', build_command: 'npm run build', start_command: 'node dist/server.js' });
    expect(res.status).toBe(201);
    expect(await row(res.body.id)).toEqual({ build_method: 'railpack', install_command: 'npm ci', build_command: 'npm run build', start_command: 'node dist/server.js' });
  });

  test('the commands are optional and may be null', async () => {
    const res = await create({ build_method: 'railpack', install_command: null, build_command: null });
    expect([res.status, res.body.install_command, res.body.build_command, res.body.start_command]).toEqual([201, null, null, null]);
  });

  test.each([
    [{ build_method: 'nixpacks' }], [{ build_method: '' }], [{ build_method: null }], [{ build_method: 'RAILPACK' }],
    [{ install_command: '' }], [{ install_command: '   ' }], [{ build_command: 'a\nb' }], [{ start_command: 'a\rb' }], [{ install_command: 'a\u0000b' }],
    [{ start_command: 'x'.repeat(1001) }], [{ install_command: 5 }], [{ build_command: ['npm run build'] }],
  ])('refuses %j', async (bad) => {
    const res = await create({ build_method: 'railpack', ...bad });
    expect(res.status).toBe(400);
  });

  test('a command of exactly 1000 characters is accepted, and surrounding spaces are trimmed', async () => {
    const res = await create({ build_method: 'railpack', start_command: `  ${'x'.repeat(1000)}  ` });
    expect([res.status, res.body.start_command]).toEqual([201, 'x'.repeat(1000)]);
  });
});

describe('editing', () => {
  test('the method and the commands can be changed, one at a time, and cleared with null', async () => {
    const id = (await create()).body.id;
    expect((await put(id, { build_method: 'railpack' })).body.build_method).toBe('railpack');
    expect((await put(id, { build_command: 'npm run build:prod' })).body).toMatchObject({ build_method: 'railpack', build_command: 'npm run build:prod', install_command: null });
    await put(id, { install_command: 'pnpm i', start_command: 'pnpm start' });
    expect(await row(id)).toEqual({ build_method: 'railpack', install_command: 'pnpm i', build_command: 'npm run build:prod', start_command: 'pnpm start' });
    await put(id, { build_command: null });
    expect((await row(id)).build_command).toBeNull();
    expect((await row(id)).install_command).toBe('pnpm i'); // only what was sent changed
  });

  test('switching back to the Dockerfile keeps the commands, so switching again loses nothing', async () => {
    const id = (await create({ build_method: 'railpack', install_command: 'npm ci' })).body.id;
    await put(id, { build_method: 'dockerfile' });
    expect(await row(id)).toMatchObject({ build_method: 'dockerfile', install_command: 'npm ci' });
  });

  test.each([[{ build_method: 'make' }], [{ build_method: null }], [{ install_command: '' }], [{ start_command: 'a\nb' }], [{ build_command: 7 }]])('refuses %j', async (bad) => {
    const id = (await create()).body.id;
    expect((await put(id, bad)).status).toBe(400);
    expect(await row(id)).toMatchObject({ build_method: 'dockerfile', install_command: null });
  });

  test('the database itself refuses a command with a line break, whatever the application does', async () => {
    const id = (await create()).body.id;
    await expect(testPool.query(`UPDATE apps SET start_command = E'a\\nb' WHERE id = $1`, [id])).rejects.toThrow();
    await expect(testPool.query(`UPDATE apps SET build_method = 'other' WHERE id = $1`, [id])).rejects.toThrow();
  });
});

describe('waiting for the next deployment', () => {
  const deployed = (id, snapshot) => testPool.query(`INSERT INTO deployments (app_id, trigger, status, config_snapshot, finished_at) VALUES ($1,'manual','successful',$2, now())`, [id, snapshot]);

  test.each([
    ['build_method', 'railpack'], ['install_command', 'npm ci'], ['build_command', 'npm run b'], ['start_command', 'npm start'],
  ])('changing %s is pending until a deployment uses it', async (key, value) => {
    const id = (await create()).body.id;
    await deployed(id, { build_method: 'dockerfile', install_command: null, build_command: null, start_command: null });
    expect((await agent.get(`/api/apps/${id}`)).body.settings_pending).toEqual([]);
    expect((await put(id, { [key]: value })).body.settings_pending).toEqual([key]);
  });

  test('a record from before this existed (no key) is not a difference', async () => {
    const id = (await create()).body.id;
    await deployed(id, {});
    expect((await put(id, { build_method: 'railpack' })).body.settings_pending).toEqual([]);
  });
});

describe('the deployment', () => {
  test('a Dockerfile app sends its method and no commands to the worker', async () => {
    const id = (await create({ install_command: 'npm ci' })).body.id; // (kept, but unused by this method)
    const res = await agent.post(`/api/apps/${id}/deployments`);
    expect(res.body.config_snapshot).toMatchObject({ build_method: 'dockerfile' });
    expect(lastJob().buildMethod).toBe('dockerfile');
  });

  test('a Railpack app sends the method and the commands it has, and leaves out the ones it does not', async () => {
    const id = (await create({ build_method: 'railpack', build_command: 'npm run build' })).body.id;
    const res = await agent.post(`/api/apps/${id}/deployments`);
    expect(res.body.config_snapshot).toMatchObject({ build_method: 'railpack', install_command: null, build_command: 'npm run build', start_command: null });
    expect(lastJob()).toMatchObject({ buildMethod: 'railpack', buildCommand: 'npm run build' });
    expect(lastJob().installCommand).toBeUndefined();
    expect(lastJob().startCommand).toBeUndefined();
  });

  test('all three commands reach the worker when all three are set', async () => {
    const id = (await create({ build_method: 'railpack', install_command: 'npm ci', build_command: 'npm run build', start_command: 'node s.js' })).body.id;
    await agent.post(`/api/apps/${id}/deployments`);
    expect(lastJob()).toMatchObject({ buildMethod: 'railpack', installCommand: 'npm ci', buildCommand: 'npm run build', startCommand: 'node s.js' });
  });

  test('the snapshot keeps what the deployment used even when the app is edited afterwards', async () => {
    const id = (await create({ build_method: 'railpack', start_command: 'node a.js' })).body.id;
    const first = await agent.post(`/api/apps/${id}/deployments`);
    await put(id, { build_method: 'dockerfile', start_command: 'node b.js' });
    const stored = (await testPool.query('SELECT config_snapshot FROM deployments WHERE id = $1', [first.body.id])).rows[0].config_snapshot;
    expect(stored).toMatchObject({ build_method: 'railpack', start_command: 'node a.js' });
  });
});

describe('a static site', () => {
  const STATIC = { build_method: 'static', container_port: 8080 };
  const staticRow = async (id) => (await testPool.query('SELECT build_method, output_dir, node_version, spa_fallback, static_server, install_command, build_command FROM apps WHERE id = $1', [id])).rows[0];

  test('is created with its settings', async () => {
    const res = await create({ ...STATIC, install_command: 'npm ci', build_command: 'npm run build', output_dir: 'dist', node_version: '20.11', spa_fallback: false, static_server: 'caddy' });
    expect(res.status).toBe(201);
    expect(await staticRow(res.body.id)).toEqual({ build_method: 'static', output_dir: 'dist', node_version: '20.11', spa_fallback: false, static_server: 'caddy', install_command: 'npm ci', build_command: 'npm run build' });
  });

  test('has sensible defaults: nginx, the single-page fallback on, no folder and no Node version (the app\'s folder, Node 22)', async () => {
    const res = await create(STATIC);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ build_method: 'static', output_dir: null, node_version: null, spa_fallback: true, static_server: 'nginx' });
  });

  test('every app has the defaults, whatever its method', async () => {
    expect((await create()).body).toMatchObject({ output_dir: null, node_version: null, spa_fallback: true, static_server: 'nginx' });
  });

  test.each([
    [{ output_dir: '/etc' }], [{ output_dir: '..' }], [{ output_dir: 'a/../b' }], [{ output_dir: 'a b' }], [{ output_dir: 'a;b' }], [{ output_dir: '' }], [{ output_dir: 'x'.repeat(201) }], [{ output_dir: 5 }],
    [{ node_version: 'latest' }], [{ node_version: '22.' }], [{ node_version: 'v22' }], [{ node_version: '1.2.3.4' }], [{ node_version: '22; rm' }], [{ node_version: '' }], [{ node_version: 22 }],
    [{ static_server: 'apache' }], [{ static_server: '' }], [{ static_server: null }], [{ spa_fallback: 'yes' }], [{ spa_fallback: null }],
  ])('refuses %j', async (bad) => {
    expect((await create({ ...STATIC, ...bad })).status).toBe(400);
  });

  test.each(['dist', 'build/web', '.', 'public_html', 'a.b-c', 'x'.repeat(200)])('accepts the folder %j', async (dir) => {
    expect((await create({ ...STATIC, output_dir: dir })).status).toBe(201);
  });

  test.each(['22', '20.11', '18.20.4', '8', '100'])('accepts the Node version %j', async (v) => {
    expect((await create({ ...STATIC, node_version: v })).status).toBe(201);
  });

  test('the folder, the version and the server may be null in an edit (back to the defaults)', async () => {
    const id = (await create({ ...STATIC, output_dir: 'dist', node_version: '20' })).body.id;
    await put(id, { output_dir: null, node_version: null });
    expect(await staticRow(id)).toMatchObject({ output_dir: null, node_version: null });
  });

  describe('its port', () => {
    test.each([1, 80, 1023])('a static site cannot use %i (neither server runs as root)', async (port) => {
      const res = await create({ ...STATIC, container_port: port });
      expect(res.status).toBe(400);
      expect(res.body.details.join(' ')).toMatch(/1024/);
      expect((await testPool.query('SELECT count(*)::int AS n FROM apps')).rows[0].n).toBe(0);
    });
    test('1024 and 8080 are fine, and any other method may still use a low port', async () => {
      expect((await create({ ...STATIC, container_port: 1024 })).status).toBe(201);
      expect((await create({ name: 'B', host_port: 8081, container_port: 80 })).status).toBe(201);
      expect((await create({ name: 'C', host_port: 8082, container_port: 80, build_method: 'railpack' })).status).toBe(201);
    });
    test('an edit is checked against the result: low port while static, or switching a low-port app to static', async () => {
      const id = (await create(STATIC)).body.id;
      expect((await put(id, { container_port: 80 })).status).toBe(400);
      const low = (await create({ name: 'Low', host_port: 8090, container_port: 80 })).body.id;
      const res = await put(low, { build_method: 'static' });
      expect([res.status, (await row(low)).build_method]).toEqual([400, 'dockerfile']);
      expect((await put(low, { build_method: 'static', container_port: 8080 })).status).toBe(200);
      expect((await put(id, { container_port: 3000 })).body.container_port).toBe(3000);
    });
    test('leaving static frees the port again', async () => {
      const id = (await create(STATIC)).body.id;
      expect((await put(id, { build_method: 'dockerfile', container_port: 80 })).status).toBe(200);
    });
  });

  test('the database itself refuses a bad folder, Node version or server', async () => {
    const id = (await create(STATIC)).body.id;
    for (const [column, value] of [['output_dir', '../x'], ['output_dir', '/abs'], ['output_dir', 'a b'], ['node_version', 'latest'], ['node_version', '22.x'], ['static_server', 'apache'], ['build_method', 'nixpacks']]) {
      await expect(testPool.query(`UPDATE apps SET ${column} = $2 WHERE id = $1`, [id, value])).rejects.toThrow(/check constraint/);
    }
  });

  test('switching the method away and back keeps the static settings', async () => {
    const id = (await create({ ...STATIC, output_dir: 'dist', node_version: '20', static_server: 'caddy', spa_fallback: false })).body.id;
    await put(id, { build_method: 'dockerfile' });
    expect(await staticRow(id)).toMatchObject({ build_method: 'dockerfile', output_dir: 'dist', node_version: '20', static_server: 'caddy', spa_fallback: false });
  });

  describe('waiting for the next deployment', () => {
    const deployed = (id, snapshot) => testPool.query(`INSERT INTO deployments (app_id, trigger, status, config_snapshot, finished_at) VALUES ($1,'manual','successful',$2, now())`, [id, snapshot]);
    test.each([['output_dir', 'build'], ['node_version', '20'], ['spa_fallback', false], ['static_server', 'caddy']])('changing %s is pending until a deployment uses it', async (key, value) => {
      const id = (await create(STATIC)).body.id;
      await deployed(id, { build_method: 'static', output_dir: null, node_version: null, spa_fallback: true, static_server: 'nginx', install_command: null, build_command: null, start_command: null });
      expect((await agent.get(`/api/apps/${id}`)).body.settings_pending).toEqual([]);
      expect((await put(id, { [key]: value })).body.settings_pending).toEqual([key]);
    });
    test('a record from before static sites existed (no keys) is not a difference', async () => {
      const id = (await create(STATIC)).body.id;
      await deployed(id, {});
      expect((await put(id, { output_dir: 'dist', static_server: 'caddy' })).body.settings_pending).toEqual([]);
    });
  });

  describe('the deployment', () => {
    test('sends the method, the commands and the static settings to the worker', async () => {
      const id = (await create({ ...STATIC, install_command: 'npm ci', build_command: 'npm run build', output_dir: 'dist', node_version: '20', spa_fallback: false, static_server: 'caddy' })).body.id;
      const res = await agent.post(`/api/apps/${id}/deployments`);
      expect(res.body.config_snapshot).toMatchObject({ build_method: 'static', output_dir: 'dist', node_version: '20', spa_fallback: false, static_server: 'caddy', install_command: 'npm ci', build_command: 'npm run build' });
      expect(lastJob()).toMatchObject({ buildMethod: 'static', installCommand: 'npm ci', buildCommand: 'npm run build', outputDir: 'dist', nodeVersion: '20', spaFallback: false, staticServer: 'caddy', containerPort: 8080 });
    });
    test('leaves out the folder and the Node version when there are none, but always says the fallback and the server', async () => {
      const id = (await create(STATIC)).body.id;
      await agent.post(`/api/apps/${id}/deployments`);
      expect(lastJob()).toMatchObject({ buildMethod: 'static', spaFallback: true, staticServer: 'nginx' });
      expect(lastJob().outputDir).toBeUndefined();
      expect(lastJob().nodeVersion).toBeUndefined();
    });
    test('the snapshot keeps what the deployment used even when the app is edited afterwards', async () => {
      const id = (await create({ ...STATIC, output_dir: 'dist' })).body.id;
      const first = await agent.post(`/api/apps/${id}/deployments`);
      await put(id, { output_dir: 'public', static_server: 'caddy' });
      const stored = (await testPool.query('SELECT config_snapshot FROM deployments WHERE id = $1', [first.body.id])).rows[0].config_snapshot;
      expect(stored).toMatchObject({ output_dir: 'dist', static_server: 'nginx' });
    });
  });
});
