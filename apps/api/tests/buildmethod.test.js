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
