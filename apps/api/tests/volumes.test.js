// Persistent storage: the paths an app keeps, what a deployment gets told, what happens to the data when a path is removed or the
// app is deleted, and the list of volumes that are kept without being mounted.
import request from 'supertest';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let queue;
let agent;
let appId;
const ZERO = '00000000-0000-0000-0000-000000000000';

beforeEach(async () => {
  await resetDb();
  await testPool.query('TRUNCATE app_volumes');
  queue = { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) };
  agent = request.agent(await makeApp({ queue }));
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  appId = (await agent.post('/api/apps').send({ name: 'App A', repo: 'o/a', container_port: 3000, host_port: 8080 })).body.id;
});
afterAll(closeDb);

const put = (paths, id = appId) => agent.put(`/api/apps/${id}/volumes`).send({ paths });
const get = (id = appId) => agent.get(`/api/apps/${id}/volumes`);
const rows = async (id = appId) => (await testPool.query('SELECT * FROM app_volumes WHERE app_id = $1 ORDER BY container_path', [id])).rows;
const deployed = (snapshot) => testPool.query(`INSERT INTO deployments (app_id, trigger, status, config_snapshot, finished_at) VALUES ($1,'manual','successful',$2, now())`, [appId, snapshot]);
const BASE_SNAPSHOT = { repo: 'o/a', branch: 'main', root_dir: '.', container_port: 3000, host_port: 8080, health_path: null, memory_mb: 512, cpus: 1, build_timeout_minutes: null };

describe('the list of paths', () => {
  test('starts empty', async () => {
    const res = await get();
    expect([res.status, res.body]).toEqual([200, { volumes: [] }]);
  });

  test('setting it creates one volume per path, named by us, sorted by path', async () => {
    const res = await put(['/data', '/app/uploads']);
    expect(res.status).toBe(200);
    expect(res.body.volumes.map((v) => [v.path, v.state])).toEqual([['/app/uploads', 'in_use'], ['/data', 'in_use']]);
    for (const v of res.body.volumes) {
      expect(v.dockerName).toBe(`shipdok-vol-${v.id}`);
      expect(v.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect((await rows()).map((r) => r.app_name)).toEqual(['App A', 'App A']);
  });

  test('is tidied: a doubled or trailing slash is fixed', async () => {
    const res = await put(['//data/', '/app//logs/']);
    expect(res.body.volumes.map((v) => v.path)).toEqual(['/app/logs', '/data']);
  });

  test('sending the same list again changes nothing (same volumes, same names)', async () => {
    const first = (await put(['/data'])).body.volumes[0];
    const second = (await put(['/data'])).body.volumes[0];
    expect(second).toMatchObject({ id: first.id, dockerName: first.dockerName, state: 'in_use' });
    expect((await rows()).length).toBe(1);
  });

  test.each([
    ['not a list', 'x'], ['an item that is not text', [5]], ['a relative path', ['data']], ['the root', ['/']], ['an empty path', ['']],
    ['/proc', ['/proc']], ['inside /proc', ['/proc/self']], ['/sys', ['/sys']], ['/dev', ['/dev/shm']],
    ['a path going up', ['/a/../b']], ['a dot segment', ['/a/./b']], ['a space', ['/my data']], ['a strange character', ['/da$ta']], ['a very long path', [`/${'a'.repeat(250)}`]],
    ['the same path twice', ['/data', '/data/']], ['a path inside another', ['/data', '/data/sub']], ['more than ten', Array.from({ length: 11 }, (_, i) => `/v${i}`)],
  ])('refuses %s', async (_, paths) => {
    const before = await rows();
    const res = await put(paths);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(await rows()).toEqual(before);
  });

  test('ten paths are fine', async () => {
    expect((await put(Array.from({ length: 10 }, (_, i) => `/v${i}`))).status).toBe(200);
  });

  test('an unknown app is a 404, and one that is being deleted a 409', async () => {
    expect((await put(['/data'], ZERO)).status).toBe(404);
    expect((await get(ZERO)).status).toBe(404);
    expect((await put(['/data'], 'not-a-uuid')).status).toBe(404);
    await testPool.query('UPDATE apps SET deleting_at = now() WHERE id = $1', [appId]);
    const res = await put(['/data']);
    expect([res.status, res.body.code]).toEqual([409, 'deleting']);
  });
});

describe('removing a path never deletes data', () => {
  test('the volume is detached, kept, and still listed', async () => {
    await put(['/data', '/uploads']);
    const res = await put(['/data']);
    expect(res.body.volumes.map((v) => [v.path, v.state])).toEqual([['/data', 'in_use'], ['/uploads', 'detached']]);
    expect((await rows()).length).toBe(2);
  });

  test('adding the same path again re-attaches the SAME volume, with its data', async () => {
    const original = (await put(['/data'])).body.volumes[0];
    await put([]);
    expect((await rows())[0].state).toBe('detached');
    const back = (await put(['/data'])).body.volumes[0];
    expect(back).toMatchObject({ id: original.id, dockerName: original.dockerName, state: 'in_use' });
    expect((await rows()).length).toBe(1);
  });
});

describe('what deployments are told', () => {
  test('the snapshot and the job carry the mounted volumes (name and path), and not the detached ones', async () => {
    await put(['/data', '/uploads']);
    await put(['/uploads']);
    const res = await agent.post(`/api/apps/${appId}/deployments`);
    const [vol] = (await rows()).filter((r) => r.state === 'in_use');
    expect(res.body.config_snapshot.volumes).toEqual([{ path: '/uploads', name: vol.docker_name }]);
    expect(queue.add.mock.calls.at(-1)[1].volumes).toEqual([{ path: '/uploads', name: vol.docker_name }]);
  });

  test('an app without volumes sends an empty list', async () => {
    const res = await agent.post(`/api/apps/${appId}/deployments`);
    expect(res.body.config_snapshot.volumes).toEqual([]);
  });

  test('a change is pending until the next deployment (and an old record without the key counts as none)', async () => {
    await deployed(BASE_SNAPSHOT);
    expect((await agent.get(`/api/apps/${appId}`)).body.settings_pending).toEqual([]);
    await put(['/data']);
    expect((await agent.get(`/api/apps/${appId}`)).body.settings_pending).toEqual(['volumes']);
    await deployed({ ...BASE_SNAPSHOT, volumes: [{ path: '/data', name: (await rows())[0].docker_name }] });
    expect((await agent.get(`/api/apps/${appId}`)).body.settings_pending).toEqual([]);
    await put([]);
    expect((await agent.get(`/api/apps/${appId}`)).body.settings_pending).toEqual(['volumes']);
  });
});

describe('deleting an app', () => {
  const del = (body = {}) => agent.delete(`/api/apps/${appId}`).send({ confirm: 'App A', ...body });

  test('keeps the volumes by default: the job says so', async () => {
    expect((await del()).status).toBe(202);
    expect(queue.add).toHaveBeenCalledWith('deleteapp', { appId, deleteVolumes: false });
  });

  test('deleting them too needs the explicit choice', async () => {
    expect((await del({ deleteVolumes: true })).status).toBe(202);
    expect(queue.add).toHaveBeenCalledWith('deleteapp', { appId, deleteVolumes: true });
  });

  test.each(['yes', 1, null, 'true'])('anything but true or false is refused (%j)', async (v) => {
    const res = await del({ deleteVolumes: v });
    expect(res.status).toBe(400);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('the volumes that are kept without being mounted', () => {
  test('lists detached and orphaned ones, never the ones in use', async () => {
    await put(['/data', '/uploads']);
    await put(['/data']);
    await testPool.query(`INSERT INTO app_volumes (app_id, app_name, container_path, docker_name, state) VALUES (NULL, 'Old app', '/files', 'shipdok-vol-orphan-1', 'orphaned')`);
    const res = await agent.get('/api/volumes');
    expect(res.status).toBe(200);
    expect(res.body.volumes.map((v) => [v.path, v.state, v.appName, v.appId === null ? null : 'has-app'])).toEqual(
      expect.arrayContaining([['/uploads', 'detached', 'App A', 'has-app'], ['/files', 'orphaned', 'Old app', null]]));
    expect(res.body.volumes.some((v) => v.path === '/data')).toBe(false);
    expect(res.body.volumes).toHaveLength(2);
  });

  test('deleting one asks the worker (the API never touches Docker) and answers 202', async () => {
    await put(['/data']);
    await put([]);
    const [v] = await rows();
    const res = await agent.delete(`/api/volumes/${v.id}`);
    expect(res.status).toBe(202);
    expect(queue.add).toHaveBeenCalledWith('removevolume', { volumeId: v.id });
  });

  test('a volume that is mounted cannot be deleted', async () => {
    await put(['/data']);
    const [v] = await rows();
    const res = await agent.delete(`/api/volumes/${v.id}`);
    expect([res.status, res.body.code]).toEqual([409, 'volume_in_use']);
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('unknown ids are a 404', async () => {
    expect((await agent.delete(`/api/volumes/${ZERO}`)).status).toBe(404);
    expect((await agent.delete('/api/volumes/not-a-uuid')).status).toBe(404);
  });

  test('a queue that is down is said plainly, and nothing changes', async () => {
    await put(['/data']);
    await put([]);
    queue.add.mockRejectedValueOnce(new Error('down'));
    const [v] = await rows();
    expect((await agent.delete(`/api/volumes/${v.id}`)).status).toBe(503);
  });

  test('a failed removal is shown with its reason', async () => {
    await put(['/data']);
    await put([]);
    const [v] = await rows();
    await testPool.query(`UPDATE app_volumes SET remove_error = 'in use by a container' WHERE id = $1`, [v.id]);
    expect((await agent.get('/api/volumes')).body.volumes[0].removeError).toBe('in use by a container');
  });
});

describe('reclaiming a kept volume', () => {
  const kept = async ({ state = 'orphaned', path = '/old', appRef = null } = {}) => (await testPool.query(
    `INSERT INTO app_volumes (app_id, app_name, container_path, docker_name, state) VALUES ($1, 'Gone app', $2, $3, $4) RETURNING *`,
    [appRef, path, `shipdok-vol-kept-${Math.random().toString(16).slice(2)}`, state])).rows[0];
  const reclaim = (id, body) => agent.post(`/api/volumes/${id}/reclaim`).send(body);
  const keptList = async () => (await agent.get('/api/volumes')).body.volumes;

  test('attaches an orphaned volume to an app at the path chosen: the same volume (name and files), now in use, named for the app', async () => {
    const v = await kept();
    const res = await reclaim(v.id, { appId, path: '/data' });
    expect(res.status).toBe(200);
    expect(res.body.volume).toMatchObject({ id: v.id, path: '/data', state: 'in_use', dockerName: v.docker_name, appId, appName: 'App A' });
    const [row] = await rows();
    expect([row.id, row.docker_name, row.state, row.container_path]).toEqual([v.id, v.docker_name, 'in_use', '/data']);
    expect(await keptList()).toEqual([]);
  });
  test('the app then mounts it at its next deployment (it is listed in its storage and in what a deployment mounts)', async () => {
    const v = await kept();
    await reclaim(v.id, { appId, path: '/data' });
    expect((await get()).body.volumes.map((x) => [x.path, x.state])).toEqual([['/data', 'in_use']]);
    const { mountedVolumes } = await import('../src/volumes.js');
    expect(await mountedVolumes(testPool, appId)).toEqual([{ path: '/data', name: v.docker_name }]);
  });
  test('a volume detached from an app can be attached to another, or the same, app', async () => {
    await put(['/data']);
    await put([]);
    const [detached] = await rows();
    expect(detached.state).toBe('detached');
    const other = (await agent.post('/api/apps').send({ name: 'App B', repo: 'o/b', container_port: 3000, host_port: 8081 })).body.id;
    expect((await reclaim(detached.id, { appId: other, path: '/files' })).status).toBe(200);
    expect((await rows(other)).map((r) => [r.container_path, r.state])).toEqual([['/files', 'in_use']]);
    expect(await rows()).toEqual([]);
  });
  test('the path is tidied the way it is in Settings', async () => {
    const v = await kept();
    const res = await reclaim(v.id, { appId, path: ' //var//data/ ' });
    expect(res.body.volume.path).toBe('/var/data');
  });
  test.each([['data'], ['/'], ['/proc/x'], ['/a/../b'], ['/with space'], [''], [null], [7]])('refuses the path %j', async (path) => {
    const v = await kept();
    const res = await reclaim(v.id, { appId, path });
    expect([res.status, res.body.code]).toEqual([400, 'bad_path']);
    expect((await keptList())).toHaveLength(1);
  });
  test('a path the app already keeps is a 409, and nothing changes', async () => {
    await put(['/data']);
    const v = await kept();
    const res = await reclaim(v.id, { appId, path: '/data' });
    expect([res.status, res.body.code]).toEqual([409, 'path_in_use']);
    expect((await keptList())[0].id).toBe(v.id);
  });
  test('a path nested with one the app keeps is refused, so is an eleventh', async () => {
    await put(['/data']);
    const v = await kept();
    expect((await reclaim(v.id, { appId, path: '/data/inner' })).body.code).toBe('bad_path');
    expect((await reclaim(v.id, { appId, path: '/' })).status).toBe(400);
    await put(Array.from({ length: 10 }, (_, i) => `/p${i}`));
    const res = await reclaim(v.id, { appId, path: '/extra' });
    expect([res.status, res.body.code]).toEqual([400, 'bad_path']);
    expect(res.body.error).toMatch(/at most 10/);
  });
  test('a volume that is mounted already cannot be reclaimed', async () => {
    await put(['/data']);
    const [mounted] = await rows();
    const res = await reclaim(mounted.id, { appId, path: '/elsewhere' });
    expect([res.status, res.body.code]).toEqual([409, 'volume_in_use']);
  });
  test('an unknown volume or app, bad ids, and an app being deleted', async () => {
    const v = await kept();
    expect((await reclaim(ZERO, { appId, path: '/data' })).status).toBe(404);
    expect((await reclaim('nope', { appId, path: '/data' })).status).toBe(404);
    expect((await reclaim(v.id, { appId: ZERO, path: '/data' })).status).toBe(404);
    expect((await reclaim(v.id, { appId: 'nope', path: '/data' })).status).toBe(400);
    expect((await reclaim(v.id, { path: '/data' })).status).toBe(400);
    await testPool.query(`UPDATE apps SET deleting_at = now() WHERE id = $1`, [appId]);
    const res = await reclaim(v.id, { appId, path: '/data' });
    expect([res.status, res.body.code]).toEqual([409, 'deleting']);
    expect((await keptList())).toHaveLength(1);
  });
  test('needs a session', async () => {
    const v = await kept();
    const anon = request(await makeApp({ queue }));
    expect((await anon.post(`/api/volumes/${v.id}/reclaim`).send({ appId, path: '/data' })).status).toBe(401);
  });
  test('a reclaimed volume can no longer be deleted as a kept one (it is in use)', async () => {
    const v = await kept();
    await reclaim(v.id, { appId, path: '/data' });
    const res = await agent.delete(`/api/volumes/${v.id}`);
    expect([res.status, res.body.code]).toEqual([409, 'volume_in_use']);
  });
  test('two reclaims at once of volumes to the same path: one wins', async () => {
    const a = await kept(); const b = await kept({ path: '/b' });
    const results = await Promise.all([reclaim(a.id, { appId, path: '/data' }), reclaim(b.id, { appId, path: '/data' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await rows()).filter((r) => r.state === 'in_use')).toHaveLength(1);
  });
});
