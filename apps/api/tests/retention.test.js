// Image retention, rollback, manual clean-up, deleting a deployment, and the disk warning. The API never touches Docker:
// it reads the history, records what the administrator asked for, and queues jobs for the worker.
import request from 'supertest';
import { jest } from '@jest/globals';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logFilePath, logDirFor } from '@shipdok/shared';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let queue;
let app;
let agent;
let appId;
let root;
let disk;
const ZERO = '00000000-0000-0000-0000-000000000000';
const MB = 1024 * 1024;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;

beforeEach(async () => {
  await resetDb();
  root = mkdtempSync(join(tmpdir(), 'api-retention-'));
  disk = { totalBytes: 100_000_000_000, freeBytes: 60_000_000_000 };
  let jobs = 0;
  queue = { add: jest.fn(async () => ({ id: String(++jobs) })), remove: jest.fn(async () => {}) };
  app = await makeApp({ queue, logDir: root, diskUsage: async () => disk });
  agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  appId = (await agent.post('/api/apps').send({ name: 'App A', repo: 'o/r', container_port: 3000, host_port: 8080 })).body.id;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); jest.restoreAllMocks(); });
afterAll(closeDb);

// A successful deployment with an image, the way the worker leaves it.
let n = 0;
async function version({ status = 'successful', bytes = 100 * MB, removed = false, image, commit, forApp = appId, rollbackOf = null, trigger = 'manual' } = {}) {
  n += 1;
  const sha = commit ?? String(n).padStart(40, 'a');
  const { rows } = await testPool.query(
    `INSERT INTO deployments (app_id, trigger, commit_sha, status, config_snapshot, finished_at, rollback_of) VALUES ($1, $2, $3, $4, '{}', now(), $5) RETURNING id`,
    [forApp, trigger, sha, status, rollbackOf]);
  const id = rows[0].id;
  if (status === 'successful') {
    await testPool.query(
      `UPDATE deployments SET image_ref = $2, image_bytes = $3, image_removed_at = ${removed ? 'now()' : 'NULL'} WHERE id = $1`,
      [id, image ?? `shipdok/app-a:${id}`, bytes]);
  }
  return id;
}
const row = async (id) => (await testPool.query('SELECT * FROM deployments WHERE id = $1', [id])).rows[0];
const jobsOf = (name) => queue.add.mock.calls.filter(([jobName]) => jobName === name);
const states = async () => Object.fromEntries((await agent.get(`/api/apps/${appId}/images`)).body.versions.map((v) => [v.deploymentId, v.state]));

describe('retention settings', () => {
  test('a new app keeps the live version and one earlier one, and does not clean up by itself', async () => {
    const a = (await agent.get(`/api/apps/${appId}`)).body;
    expect([a.keep_previous_images, a.auto_prune]).toEqual([1, false]);
  });

  test('can be chosen when the app is created', async () => {
    const res = await agent.post('/api/apps').send({ name: 'App B', repo: 'o/r', container_port: 3000, host_port: 8081, keep_previous_images: 3, auto_prune: true });
    expect([res.body.keep_previous_images, res.body.auto_prune]).toEqual([3, true]);
  });

  test.each([[{ keep_previous_images: -1 }], [{ keep_previous_images: 11 }], [{ keep_previous_images: 1.5 }], [{ keep_previous_images: '2' }], [{ auto_prune: 'yes' }], [{ auto_prune: 1 }]])('creating with %j is refused', async (extra) => {
    const res = await agent.post('/api/apps').send({ name: 'App B', repo: 'o/r', container_port: 3000, host_port: 8081, ...extra });
    expect(res.status).toBe(400);
  });

  test('PUT changes either setting or both, and leaves the other alone', async () => {
    expect((await agent.put(`/api/apps/${appId}/retention`).send({ keep_previous_images: 4 })).body).toEqual({ keep_previous_images: 4, auto_prune: false });
    expect((await agent.put(`/api/apps/${appId}/retention`).send({ auto_prune: true })).body).toEqual({ keep_previous_images: 4, auto_prune: true });
    expect((await agent.put(`/api/apps/${appId}/retention`).send({ keep_previous_images: 0, auto_prune: false })).body).toEqual({ keep_previous_images: 0, auto_prune: false });
  });

  test.each([[{}], [{ keep_previous_images: 99 }], [{ auto_prune: 'on' }], [{ name: 'x' }], [{ keep_previous_images: 1, host_port: 1 }]])('PUT %j is refused and changes nothing', async (body) => {
    const res = await agent.put(`/api/apps/${appId}/retention`).send(body);
    expect(res.status).toBe(400);
    const a = (await agent.get(`/api/apps/${appId}`)).body;
    expect([a.keep_previous_images, a.auto_prune, a.host_port]).toEqual([1, false, 8080]);
  });

  test('PUT needs a login, and an unknown app is a 404', async () => {
    expect((await request(app).put(`/api/apps/${appId}/retention`).send({ auto_prune: true })).status).toBe(401);
    expect((await agent.put(`/api/apps/${ZERO}/retention`).send({ auto_prune: true })).status).toBe(404);
    expect((await agent.put('/api/apps/not-a-uuid/retention').send({ auto_prune: true })).status).toBe(404);
  });
});

describe('GET /api/apps/:id/images', () => {
  test('needs a login; unknown apps are a 404', async () => {
    expect((await request(app).get(`/api/apps/${appId}/images`)).status).toBe(401);
    expect((await agent.get(`/api/apps/${ZERO}/images`)).status).toBe(404);
    expect((await agent.get('/api/apps/not-a-uuid/images')).status).toBe(404);
  });

  test('an app with no versions has an empty list', async () => {
    const { body } = await agent.get(`/api/apps/${appId}/images`);
    expect(body).toMatchObject({ versions: [], prunableBytes: 0, keep_previous_images: 1, auto_prune: false, cleanup: null });
  });

  test('the newest version is live, the one before it is kept, the rest could be pruned', async () => {
    const [v1, v2, v3, v4] = [await version(), await version(), await version(), await version()];
    expect(await states()).toEqual({ [v4]: 'live', [v3]: 'previous', [v2]: 'prunable', [v1]: 'prunable' });
    const { body } = await agent.get(`/api/apps/${appId}/images`);
    expect(body.prunableBytes).toBe(200 * MB);
    expect(body.versions.map((v) => v.deploymentId)).toEqual([v4, v3, v2, v1]);
    expect(body.versions.map((v) => v.canRollBackTo)).toEqual([false, true, true, true]);
  });

  test('keeping more versions changes the answer', async () => {
    const ids = [await version(), await version(), await version(), await version()];
    await agent.put(`/api/apps/${appId}/retention`).send({ keep_previous_images: 3 });
    expect(Object.values(await states()).sort()).toEqual(['live', 'previous', 'previous', 'previous']);
    await agent.put(`/api/apps/${appId}/retention`).send({ keep_previous_images: 0 });
    expect((await states())[ids[2]]).toBe('prunable');
  });

  test('failed, cancelled and unfinished deployments are not versions', async () => {
    const v1 = await version();
    await version({ status: 'failed' });
    await version({ status: 'cancelled' });
    const v2 = await version();
    expect(Object.keys(await states()).sort()).toEqual([v1, v2].sort());
  });

  test('a removed image stays in the history as "removed" and takes no slot', async () => {
    const v1 = await version({ removed: true });
    const v2 = await version();
    const v3 = await version();
    expect(await states()).toEqual({ [v3]: 'live', [v2]: 'previous', [v1]: 'removed' });
  });

  test('a rollback shares its image with the version it went back to, and shares its state', async () => {
    const v1 = await version();
    const v2 = await version();
    const back = await version({ image: `shipdok/app-a:${v1}`, rollbackOf: v1, trigger: 'rollback' });
    const s = await states();
    expect(s[back]).toBe('live');
    expect(s[v1]).toBe('live');
    expect(s[v2]).toBe('previous');
    expect((await agent.get(`/api/apps/${appId}/images`)).body.prunableBytes).toBe(0);
  });

  test('prunable space counts a shared image once', async () => {
    const v1 = await version({ bytes: 50 * MB });
    await version({ image: `shipdok/app-a:${v1}`, bytes: 50 * MB, rollbackOf: v1, trigger: 'rollback' });
    await version();
    await version();
    expect((await agent.get(`/api/apps/${appId}/images`)).body.prunableBytes).toBe(50 * MB); // two rows, one image
  });

  test('another app\'s versions are not listed', async () => {
    const other = (await agent.post('/api/apps').send({ name: 'App B', repo: 'o/r', container_port: 3000, host_port: 8081 })).body.id;
    await version({ forApp: other });
    await version();
    expect((await agent.get(`/api/apps/${appId}/images`)).body.versions).toHaveLength(1);
  });

  test('shows the last clean-up', async () => {
    await testPool.query(`INSERT INTO app_cleanup (app_id, trigger, images_removed, freed_bytes, skipped) VALUES ($1, 'manual', 2, 12345, 1)`, [appId]);
    const { body } = await agent.get(`/api/apps/${appId}/images`);
    expect(body.cleanup).toMatchObject({ trigger: 'manual', images_removed: 2, freed_bytes: 12345, skipped: 1 });
    expect((await agent.get(`/api/apps/${appId}`)).body.cleanup).toMatchObject({ images_removed: 2 });
  });
});

describe('POST /api/apps/:id/prune', () => {
  test('queues a clean-up for the worker, and changes nothing itself', async () => {
    const v = [await version(), await version(), await version()];
    const res = await agent.post(`/api/apps/${appId}/prune`);
    expect(res.status).toBe(202);
    expect(jobsOf('prune')).toEqual([['prune', { appId, trigger: 'manual' }]]);
    expect((await row(v[0])).image_removed_at).toBeNull();
  });

  test('needs a login; unknown apps are a 404 and queue nothing', async () => {
    expect((await request(app).post(`/api/apps/${appId}/prune`)).status).toBe(401);
    expect((await agent.post(`/api/apps/${ZERO}/prune`)).status).toBe(404);
    expect((await agent.post('/api/apps/not-a-uuid/prune')).status).toBe(404);
    expect(jobsOf('prune')).toHaveLength(0);
  });

  test('a queue that is down is a clear 503', async () => {
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    const res = await agent.post(`/api/apps/${appId}/prune`);
    expect(res.status).toBe(503);
    expect(res.body.error).not.toMatch(/redis/i);
  });
});

describe('POST /api/apps/:id/rollback', () => {
  test('runs the previous version\'s image again: a new deployment, no commit to build, the old image named in the job', async () => {
    const v1 = await version({ commit: '1'.repeat(40) });
    const v2 = await version();
    const res = await agent.post(`/api/apps/${appId}/rollback`);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ trigger: 'rollback', status: 'queued', rollback_of: v1, commit_sha: '1'.repeat(40) });
    const [, payload] = jobsOf('deploy')[0];
    expect(payload).toMatchObject({ deploymentId: res.body.id, appId, reuseImage: `shipdok/app-a:${v1}` });
    expect(payload.commit).toBeUndefined();
    expect((await row(v2)).status).toBe('successful'); // the version it replaces is untouched until the worker swaps
  });

  test('can name the version to go back to', async () => {
    const v1 = await version();
    await version();
    await version();
    const res = await agent.post(`/api/apps/${appId}/rollback`).send({ deploymentId: v1 });
    expect(res.status).toBe(202);
    expect(res.body.rollback_of).toBe(v1);
    expect(jobsOf('deploy')[0][1].reuseImage).toBe(`shipdok/app-a:${v1}`);
  });

  test('uses the app\'s CURRENT settings, not the old deployment\'s', async () => {
    await testPool.query(`UPDATE apps SET memory_mb = 1024 WHERE id = $1`, [appId]);
    await version();
    await version();
    const res = await agent.post(`/api/apps/${appId}/rollback`);
    expect(res.body.config_snapshot).toMatchObject({ memory_mb: 1024, host_port: 8080 });
    expect(jobsOf('deploy')[0][1]).toMatchObject({ memoryMb: 1024, hostPort: 8080 });
  });

  test('with only one version there is nothing to go back to', async () => {
    await version();
    const res = await agent.post(`/api/apps/${appId}/rollback`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no earlier version/i);
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('nothing deployed yet', async () => {
    const res = await agent.post(`/api/apps/${appId}/rollback`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/nothing has been deployed/i);
  });

  test('a version whose image was removed cannot be rolled back to; the default skips it', async () => {
    const old = await version({ removed: true });
    const v2 = await version();
    await version();
    const named = await agent.post(`/api/apps/${appId}/rollback`).send({ deploymentId: old });
    expect(named.status).toBe(409);
    expect(named.body.error).toMatch(/removed/i);
    expect((await agent.post(`/api/apps/${appId}/rollback`)).body.rollback_of).toBe(v2);
  });

  test('the default skips a removed version even when it is the newest one before the live version', async () => {
    const v1 = await version();
    await version({ removed: true });
    await version();
    expect((await agent.post(`/api/apps/${appId}/rollback`)).body.rollback_of).toBe(v1);
  });

  test('rolling back to the version that is already running is refused', async () => {
    await version();
    const live = await version();
    const res = await agent.post(`/api/apps/${appId}/rollback`).send({ deploymentId: live });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });

  test('only a successful deployment of THIS app can be named', async () => {
    const other = (await agent.post('/api/apps').send({ name: 'App B', repo: 'o/r', container_port: 3000, host_port: 8081 })).body.id;
    const foreign = await version({ forApp: other });
    const failed = await version({ status: 'failed' });
    await version();
    await version();
    for (const id of [foreign, failed, ZERO]) {
      expect((await agent.post(`/api/apps/${appId}/rollback`).send({ deploymentId: id })).status).toBe(404);
    }
    expect(queue.add).not.toHaveBeenCalled();
  });

  test.each([[{ deploymentId: 'x' }], [{ deploymentId: 5 }], [{ start: 'yes' }], [{ image: 'nginx' }], [{ reuseImage: 'nginx' }]])('a bad request %j is refused', async (body) => {
    await version();
    await version();
    expect((await agent.post(`/api/apps/${appId}/rollback`).send(body)).status).toBe(400);
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('the client cannot choose the image: only the stored one is used', async () => {
    await version();
    await version();
    await agent.post(`/api/apps/${appId}/rollback`).send({ deploymentId: ZERO, image: 'evil' });
    expect(jobsOf('deploy')).toHaveLength(0);
  });

  test('needs a login; unknown apps are a 404', async () => {
    await version();
    await version();
    expect((await request(app).post(`/api/apps/${appId}/rollback`)).status).toBe(401);
    expect((await agent.post(`/api/apps/${ZERO}/rollback`)).status).toBe(404);
    expect((await agent.post('/api/apps/not-a-uuid/rollback')).status).toBe(404);
  });

  test('a stopped app stays stopped unless start is asked for', async () => {
    await version();
    await version();
    await agent.post(`/api/apps/${appId}/rollback`);
    await agent.post(`/api/apps/${appId}/rollback`).send({ start: true });
    expect(jobsOf('deploy').map(([, p]) => p.startAfterDeploy)).toEqual([undefined, true]);
  });

  test('newest wins, like any deployment: an older queued one is superseded', async () => {
    await version();
    await version();
    const queued = (await agent.post(`/api/apps/${appId}/deployments`)).body.id;
    const rollback = (await agent.post(`/api/apps/${appId}/rollback`)).body.id;
    expect((await row(queued)).status).toBe('superseded');
    expect((await row(queued)).superseded_by).toBe(rollback);
  });

  test('works even when the disk is critical: it builds nothing', async () => {
    await version();
    await version();
    disk = { totalBytes: 100, freeBytes: 1 };
    expect((await agent.post(`/api/apps/${appId}/rollback`)).status).toBe(202);
  });

  test('a queue that is down marks the new deployment failed and is a clear 503', async () => {
    await version();
    await version();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    const res = await agent.post(`/api/apps/${appId}/rollback`);
    expect(res.status).toBe(503);
    expect((await row(res.body.deploymentId)).status).toBe('failed');
  });
});

describe('the disk warning before a build', () => {
  const deploy = (body = {}) => agent.post(`/api/apps/${appId}/deployments`).send(body);

  test('plenty of space: no warning, nothing changes', async () => {
    const res = await deploy();
    expect(res.status).toBe(202);
    expect(res.body.warning).toBeUndefined();
  });

  test('low space: it deploys and says the disk is getting full', async () => {
    disk = { totalBytes: 100, freeBytes: 15 };
    const res = await deploy();
    expect(res.status).toBe(202);
    expect(res.body.warning).toMatch(/getting full \(15% free\)/);
    expect(res.body.disk.level).toBe('low');
  });

  test('critical space: it stops and asks, and queues nothing', async () => {
    disk = { totalBytes: 100, freeBytes: 5 };
    const res = await deploy();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'disk_critical', disk: { level: 'critical', freePercent: 5 } });
    expect(res.body.error).toMatch(/ignoreDiskWarning/);
    expect(queue.add).not.toHaveBeenCalled();
    expect((await testPool.query('SELECT count(*)::int AS n FROM deployments')).rows[0].n).toBe(0);
  });

  test('critical space and "deploy anyway": it deploys, and still says so', async () => {
    disk = { totalBytes: 100, freeBytes: 5 };
    const res = await deploy({ ignoreDiskWarning: true });
    expect(res.status).toBe(202);
    expect(res.body.warning).toMatch(/almost full/i);
    expect(jobsOf('deploy')).toHaveLength(1);
  });

  test('only exactly true confirms', async () => {
    disk = { totalBytes: 100, freeBytes: 5 };
    expect((await deploy({ ignoreDiskWarning: 'true' })).status).toBe(400);
    expect((await deploy({ ignoreDiskWarning: false })).status).toBe(409);
  });

  test('the edges: 10% free is low, below 10% is critical, 20% is fine', async () => {
    const level = async (free) => { disk = { totalBytes: 100, freeBytes: free }; const r = await deploy({ ignoreDiskWarning: true }); return r.body.disk?.level ?? 'ok'; };
    expect(await level(20)).toBe('ok');
    expect(await level(19)).toBe('low');
    expect(await level(10)).toBe('low');
    expect(await level(9)).toBe('critical');
  });

  test('a disk that cannot be measured does not stop a deployment', async () => {
    const broken = request.agent(await makeApp({ queue, logDir: root, diskUsage: async () => { throw new Error('nope'); } }));
    await broken.post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    expect((await broken.post(`/api/apps/${appId}/deployments`)).status).toBe(202);
  });

  test('start, stop and restart are not held back by a full disk', async () => {
    disk = { totalBytes: 100, freeBytes: 1 };
    for (const action of ['stop', 'start', 'restart']) expect((await agent.post(`/api/apps/${appId}/${action}`)).status).toBe(202);
  });
});

describe('a push when the disk is critical', () => {
  const sign = (body) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  const push = async () => {
    const raw = JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40), deleted: false, repository: { full_name: 'o/r' } });
    return request(app).post('/api/webhooks/github').set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push').set('X-GitHub-Delivery', randomUUID()).set('X-Hub-Signature-256', sign(raw)).send(raw);
  };

  test('with space to spare it deploys, as before', async () => {
    const res = await push();
    expect(res.body.status).toBe('deployed');
  });

  test('on a critical disk nothing is built, and the delivery history says why', async () => {
    disk = { totalBytes: 100, freeBytes: 4 };
    const res = await push();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ignored' });
    expect(res.body.reason).toMatch(/disk is almost full/i);
    expect(jobsOf('deploy')).toHaveLength(0);
    const hist = (await agent.get('/api/webhooks/deliveries')).body;
    const d = (hist.deliveries ?? hist)[0];
    expect(d.outcome).toBe('ignored');
    expect(JSON.stringify(d.details)).toMatch(/4% free/);
  });

  test('a low disk still builds', async () => {
    disk = { totalBytes: 100, freeBytes: 15 };
    expect((await push()).body.status).toBe('deployed');
  });

  test('a stopped app is reported as stopped, not as a disk problem', async () => {
    disk = { totalBytes: 100, freeBytes: 4 };
    await agent.post(`/api/apps/${appId}/stop`);
    expect((await push()).body.reason).toMatch(/stopped/i);
  });
});

describe('DELETE /api/deployments/:id', () => {
  const del = (id) => agent.delete(`/api/deployments/${id}`);
  const writeBuildLog = (dep, text = 'build output\n') => {
    mkdirSync(logDirFor(root, appId, dep), { recursive: true });
    writeFileSync(logFilePath(root, appId, dep, 'build'), text);
  };

  test('needs a login; unknown ids are a 404', async () => {
    const v = await version({ status: 'failed' });
    expect((await request(app).delete(`/api/deployments/${v}`)).status).toBe(401);
    expect((await del(ZERO)).status).toBe(404);
    expect((await del('not-a-uuid')).status).toBe(404);
    expect(await row(v)).toBeDefined();
  });

  test('removes the record and the build log; a failed deployment has no image to remove', async () => {
    const failed = await version({ status: 'failed' });
    writeBuildLog(failed, 'x'.repeat(500));
    const res = await del(failed);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, freedLogBytes: 500, image: 'none' });
    expect(await row(failed)).toBeUndefined();
    expect(existsSync(logDirFor(root, appId, failed))).toBe(false);
    expect(jobsOf('removeimage')).toHaveLength(0);
  });

  test('an old version: the record, the log, and its image (through the worker)', async () => {
    const old = await version();
    await version();
    await version();
    writeBuildLog(old);
    const res = await del(old);
    expect(res.status).toBe(200);
    expect(res.body.image).toBe('queued');
    expect(jobsOf('removeimage')).toEqual([['removeimage', { appId, image: `shipdok/app-a:${old}` }]]);
    expect(await row(old)).toBeUndefined();
  });

  test('deleting a deployment never touches the other deployments\' logs or the app\'s runtime logs', async () => {
    const old = await version();
    const keep = await version();
    await version();
    await version();
    writeBuildLog(old);
    writeBuildLog(keep, 'keep me\n');
    writeFileSync(join(root, appId, 'runtime.log'), 'runtime\n');
    await del(old);
    expect(existsSync(logFilePath(root, appId, keep, 'build'))).toBe(true);
    expect(existsSync(join(root, appId, 'runtime.log'))).toBe(true);
  });

  test('the running version cannot be deleted', async () => {
    await version();
    const live = await version();
    const res = await del(live);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/running version/i);
    expect(await row(live)).toBeDefined();
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('the version kept for rollback cannot be deleted either, until it is not kept any more', async () => {
    const prev = await version();
    await version();
    expect((await del(prev)).status).toBe(409);
    expect(await row(prev)).toBeDefined();
    await agent.put(`/api/apps/${appId}/retention`).send({ keep_previous_images: 0 });
    expect((await del(prev)).status).toBe(200);
  });

  test('a rollback row and the row it went back to share one image: either may go while the other holds it', async () => {
    const v1 = await version();
    await version();
    const back = await version({ image: `shipdok/app-a:${v1}`, rollbackOf: v1, trigger: 'rollback' });
    const res = await del(v1); // the rollback still holds the image
    expect(res.status).toBe(200);
    expect(res.body.image).toMatch(/kept/);
    expect(jobsOf('removeimage')).toHaveLength(0);
    expect(await row(back)).toBeDefined();
  });

  test('the running version\'s record stays even when an older record shares its image', async () => {
    const v1 = await version();
    await version();
    const back = await version({ image: `shipdok/app-a:${v1}`, rollbackOf: v1, trigger: 'rollback' });
    const res = await del(back);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/running version/i);
    expect(await row(back)).toBeDefined();
    expect((await agent.get(`/api/apps/${appId}/images`)).body.versions[0].deploymentId).toBe(back);
  });

  test('a deployment that is still running cannot be deleted', async () => {
    for (const status of ['queued', 'building', 'starting', 'validating']) {
      const id = await version({ status });
      writeBuildLog(id);
      expect((await del(id)).status).toBe(409);
      expect(await row(id)).toBeDefined();
      expect(existsSync(logFilePath(root, appId, id, 'build'))).toBe(true);
    }
  });

  test('a version a queued rollback is going to use cannot be deleted', async () => {
    const v1 = await version();
    await version();
    await version();
    await version({ status: 'queued', rollbackOf: v1, trigger: 'rollback' });
    const res = await del(v1);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/rollback to this version is waiting/i);
  });

  test('a version whose image was already removed can be deleted without asking the worker for anything', async () => {
    const old = await version({ removed: true });
    await version();
    const res = await del(old);
    expect(res.status).toBe(200);
    expect(res.body.image).toBe('none');
    expect(jobsOf('removeimage')).toHaveLength(0);
  });

  test('if the image removal cannot be queued the deployment is still deleted, and the answer says so', async () => {
    const old = await version();
    await version();
    await version();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    const res = await del(old);
    expect(res.status).toBe(200);
    expect(res.body.image).toBe('failed');
    expect(await row(old)).toBeUndefined();
  });

  test('files that cannot be removed: a clear error and NOTHING deleted', async () => {
    const { chmodSync } = await import('node:fs');
    if (process.getuid?.() === 0) return;
    const old = await version({ status: 'failed' });
    writeBuildLog(old);
    const dir = logDirFor(root, appId, old);
    chmodSync(dir, 0o500);
    try {
      const res = await del(old);
      expect(res.status).toBe(500);
      expect(res.body.error).not.toContain(root);
      expect(await row(old)).toBeDefined();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test('deleting twice: the second is a 404', async () => {
    const f = await version({ status: 'failed' });
    expect((await del(f)).status).toBe(200);
    expect((await del(f)).status).toBe(404);
  });

  test('an older deployment that this one superseded keeps working: its link just disappears', async () => {
    const older = await version({ status: 'failed' });
    const newer = await version({ status: 'failed' });
    await testPool.query('UPDATE deployments SET superseded_by = $2 WHERE id = $1', [older, newer]);
    expect((await del(newer)).status).toBe(200);
    expect((await row(older)).superseded_by).toBeNull();
  });
});

describe('GET /api/storage with images', () => {
  test('adds up the images Shipdok holds per app, counting a shared image once, and leaving out removed ones', async () => {
    const v1 = await version({ bytes: 100 * MB });
    await version({ bytes: 40 * MB });
    await version({ image: `shipdok/app-a:${v1}`, bytes: 100 * MB, rollbackOf: v1, trigger: 'rollback' });
    await version({ bytes: 999 * MB, removed: true });
    await version({ status: 'failed' });
    const { body } = await agent.get('/api/storage');
    expect(body.images.totalBytes).toBe(140 * MB);
    expect(body.images.apps).toEqual([{ appId, slug: 'app-a', images: 2, bytes: 140 * MB }]);
  });

  test('with no images: zero', async () => {
    expect((await agent.get('/api/storage')).body.images).toEqual({ totalBytes: 0, apps: [] });
  });
});
