// Reading and deleting a deployment's log, and the storage summary. The worker writes the files; the API only reads
// them, so the tests write files the way the worker does and check what the API makes of them.
import request from 'supertest';
import { jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatLine, logFilePath, logDirFor, runtimeLogPath } from '@shipdok/shared';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let root;
let disk;
let app;
let agent;
let appId;
let depId;
const ZERO = '00000000-0000-0000-0000-000000000000';
const T = new Date('2026-10-19T12:00:00.000Z');
const line = (n) => formatLine(T, 'stdout', `line ${n}`);
const lines = (from, to) => Array.from({ length: to - from }, (_, i) => line(from + i)).join('');

beforeEach(async () => {
  await resetDb();
  root = mkdtempSync(join(tmpdir(), 'api-logs-'));
  disk = { totalBytes: 100_000_000_000, freeBytes: 60_000_000_000 };
  app = await makeApp({ queue: { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn() }, logDir: root, diskUsage: async () => disk });
  agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  appId = (await agent.post('/api/apps').send({ name: 'App A', repo: 'o/r', container_port: 3000, host_port: 8080 })).body.id;
  depId = await deployment(appId);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
afterAll(closeDb);

async function deployment(forApp, status = 'successful') {
  const { rows } = await testPool.query(
    `INSERT INTO deployments (app_id, trigger, status, config_snapshot) VALUES ($1, 'manual', $2, '{}') RETURNING id`, [forApp, status]);
  return rows[0].id;
}
function writeLog(forApp, forDep, content, { kind = 'build', finished = true, truncated = false, bytes } = {}) {
  mkdirSync(logDirFor(root, forApp, forDep), { recursive: true });
  writeFileSync(logFilePath(root, forApp, forDep, kind), content);
  return testPool.query(
    `INSERT INTO log_files (deployment_id, app_id, kind, bytes, truncated, ended_at) VALUES ($1, $2, $3, $4, $5, ${finished ? 'now()' : 'NULL'})
     ON CONFLICT (deployment_id, kind) DO UPDATE SET bytes = $4, truncated = $5, ended_at = ${finished ? 'now()' : 'NULL'}`,
    [forDep, forApp, kind, finished ? (bytes ?? Buffer.byteLength(content)) : 0, truncated]);
}
// An app's runtime log (one pair per app): the file, and the record the worker keeps.
function writeRuntime(forApp, content, { kind = 'runtime', finished = true, truncated = false, deployment = null } = {}) {
  mkdirSync(join(root, forApp), { recursive: true });
  writeFileSync(runtimeLogPath(root, forApp, kind), content);
  return testPool.query(
    `INSERT INTO runtime_logs (app_id, kind, deployment_id, bytes, truncated, ended_at) VALUES ($1, $2, $3, $4, $5, ${finished ? 'now()' : 'NULL'})
     ON CONFLICT (app_id, kind) DO UPDATE SET deployment_id = $3, bytes = $4, truncated = $5, ended_at = ${finished ? 'now()' : 'NULL'}`,
    [forApp, kind, deployment, finished ? Buffer.byteLength(content) : 0, truncated]);
}
const get = (id, qs = '') => agent.get(`/api/deployments/${id}/logs${qs}`);

describe('GET /api/deployments/:id/logs', () => {
  test('needs a login', async () => {
    expect((await request(app).get(`/api/deployments/${depId}/logs`)).status).toBe(401);
  });

  test('unknown, malformed, or log-less deployments are a 404', async () => {
    expect((await get(ZERO)).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
    expect((await get(depId)).status).toBe(404); // a deployment from before logs existed, or one that never started
  });

  test('returns the whole log when it is small, with where to continue and whether it is finished', async () => {
    await writeLog(appId, depId, lines(0, 5));
    const res = await get(depId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text: lines(0, 5), offset: 0, nextOffset: Buffer.byteLength(lines(0, 5)), size: Buffer.byteLength(lines(0, 5)), complete: true, truncated: false });
  });

  test('paging reproduces the whole log without gaps or repeats', async () => {
    const content = lines(0, 3000);
    await writeLog(appId, depId, content);
    let offset = 0; let text = ''; let pages = 0;
    for (; pages < 100; pages++) {
      const res = await get(depId, `?offset=${offset}&limit=40000`);
      expect(res.status).toBe(200);
      text += res.body.text;
      offset = res.body.nextOffset;
      if (res.body.complete) break;
    }
    expect(text).toBe(content);
    expect(pages).toBeGreaterThan(1);
  });

  test('is not "complete" while the deployment is still writing it, even when everything so far was read', async () => {
    await writeLog(appId, depId, lines(0, 3), { finished: false });
    const res = await get(depId);
    expect(res.body.text).toBe(lines(0, 3));
    expect(res.body.complete).toBe(false);
  });

  test('not "complete" when more of a finished log is still to be read', async () => {
    await writeLog(appId, depId, lines(0, 3000));
    expect((await get(depId, '?limit=40000')).body.complete).toBe(false);
  });

  test('a half-written last line is held back until it ends', async () => {
    await writeLog(appId, depId, line(0) + '2026-10-19T12:00:00.000Z stdout half', { finished: false });
    expect((await get(depId)).body.text).toBe(line(0));
  });

  test('?tail=N returns the last N lines', async () => {
    await writeLog(appId, depId, lines(0, 100));
    const res = await get(depId, '?tail=3');
    expect(res.body.text).toBe(lines(97, 100));
    expect(res.body.nextOffset).toBe(res.body.size);
  });

  test('reports when the size limit cut the log short', async () => {
    await writeLog(appId, depId, lines(0, 2), { truncated: true });
    expect((await get(depId)).body.truncated).toBe(true);
  });

  test.each([
    ['a negative offset', '?offset=-1'], ['a fractional offset', '?offset=1.5'], ['a non-numeric offset', '?offset=abc'],
    ['a zero limit', '?limit=0'], ['a huge limit', '?limit=99999999'], ['a non-numeric limit', '?limit=x'],
    ['tail 0', '?tail=0'], ['tail too big', '?tail=100000'], ['tail not a number', '?tail=all'],
    ['tail together with offset', '?tail=5&offset=10'],
  ])('refuses %s', async (_label, qs) => {
    await writeLog(appId, depId, lines(0, 5));
    expect((await get(depId, qs)).status).toBe(400);
  });

  test('never reveals where the file is on the server', async () => {
    await writeLog(appId, depId, lines(0, 2));
    const body = JSON.stringify((await get(depId)).body);
    expect(body).not.toContain(root);
    expect(body).not.toContain(appId);
  });

  test('another deployment\'s log is not reachable through this id', async () => {
    const other = await deployment(appId);
    await writeLog(appId, other, 'secret-of-other\n');
    await writeLog(appId, depId, lines(0, 1));
    expect((await get(depId)).body.text).not.toContain('secret-of-other');
  });
});

describe('the deployment endpoint serves build logs only', () => {
  test('the default and ?kind=build are the build log', async () => {
    await writeLog(appId, depId, lines(0, 2));
    expect((await get(depId)).body.text).toBe(lines(0, 2));
    expect((await get(depId, '?kind=build')).body.text).toBe(lines(0, 2));
  });

  test.each([['?kind=runtime'], ['?kind=previous'], ['?kind=../build'], ['?kind=runtime.previous'], ['?kind='], ['?kind=BUILD'], ['?kind=all']])('refuses kind %s', async (qs) => {
    await writeLog(appId, depId, lines(0, 2));
    await writeRuntime(appId, lines(5, 6)); // an app-level log must not leak through a deployment id
    expect((await get(depId, qs)).status).toBe(400);
  });
});

describe('GET /api/apps/:id/logs (the app\'s runtime log: one per app)', () => {
  const getApp = (id, qs = '') => agent.get(`/api/apps/${id}/logs${qs}`);

  test('needs a login', async () => {
    expect((await request(app).get(`/api/apps/${appId}/logs`)).status).toBe(401);
  });

  test('unknown or malformed app ids are a 404', async () => {
    expect((await getApp(ZERO)).status).toBe(404);
    expect((await getApp('not-a-uuid')).status).toBe(404);
  });

  test('an app whose output was never collected has no runtime log (404), even when it has deployments', async () => {
    const res = await getApp(appId);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no output/i);
  });

  test('works without any successful deployment: the log belongs to the app', async () => {
    await testPool.query(`UPDATE deployments SET status = 'failed' WHERE id = $1`, [depId]);
    await writeRuntime(appId, lines(0, 2));
    expect((await getApp(appId)).body.text).toBe(lines(0, 2));
  });

  test('there is ONE runtime log per app, whichever deployment wrote it, and it says which', async () => {
    const newer = await deployment(appId);
    await writeLog(appId, depId, 'a build log that is not runtime output\n');
    await writeRuntime(appId, lines(0, 3), { deployment: newer });
    const res = await getApp(appId, '?tail=10');
    expect(res.body.text).toBe(lines(0, 3));
    expect(res.body.deploymentId).toBe(newer);
  });

  test('another app\'s log is not reachable through this id', async () => {
    const other = (await agent.post('/api/apps').send({ name: 'App B', repo: 'o/r', container_port: 3000, host_port: 8081 })).body.id;
    await writeRuntime(other, 'not yours\n');
    expect((await getApp(appId)).status).toBe(404);
  });

  test('supports kind=previous, tail and paging', async () => {
    await writeRuntime(appId, lines(0, 50));
    await writeRuntime(appId, lines(500, 502), { kind: 'runtime_previous' });
    expect((await getApp(appId, '?tail=2')).body.text).toBe(lines(48, 50));
    expect((await getApp(appId, '?kind=previous')).body.text).toBe(lines(500, 502));
    expect((await getApp(appId, '?offset=0&limit=100000')).body.text).toBe(lines(0, 50));
  });

  test('an app that is stopped still shows its last run (the log outlives the container)', async () => {
    await writeRuntime(appId, lines(0, 4));
    await testPool.query(`UPDATE apps SET desired_state = 'stopped' WHERE id = $1`, [appId]);
    expect((await getApp(appId, '?tail=4')).body.text).toBe(lines(0, 4));
  });

  test('"complete" and "truncated" belong to the kind that was asked for', async () => {
    await writeRuntime(appId, lines(0, 3), { finished: false, truncated: true });
    await writeRuntime(appId, lines(0, 2), { kind: 'runtime_previous', truncated: false });
    const current = (await getApp(appId)).body;
    const previous = (await getApp(appId, '?kind=previous')).body;
    expect([current.complete, current.truncated]).toEqual([false, true]);
    expect([previous.complete, previous.truncated]).toEqual([true, false]);
  });

  test.each([['?kind=build'], ['?kind=runtime_previous'], ['?kind=../runtime'], ['?kind='], ['?kind=all']])('refuses kind %s', async (qs) => {
    await writeRuntime(appId, lines(0, 2));
    expect((await getApp(appId, qs)).status).toBe(400);
  });
});

describe('DELETE /api/apps/:id/logs (the app\'s runtime logs)', () => {
  const del = (id) => agent.delete(`/api/apps/${id}/logs`);

  test('needs a login', async () => {
    await writeRuntime(appId, lines(0, 2));
    expect((await request(app).delete(`/api/apps/${appId}/logs`)).status).toBe(401);
    expect(existsSync(runtimeLogPath(root, appId, 'runtime'))).toBe(true);
  });

  test('removes both runtime logs and their records, says how much it freed, and leaves every build log alone', async () => {
    await writeLog(appId, depId, lines(0, 3));
    await writeRuntime(appId, lines(0, 10));
    await writeRuntime(appId, lines(0, 4), { kind: 'runtime_previous' });
    const res = await del(appId);
    expect(res.status).toBe(200);
    expect(res.body.freedBytes).toBe(Buffer.byteLength(lines(0, 10)) + Buffer.byteLength(lines(0, 4)));
    expect(existsSync(runtimeLogPath(root, appId, 'runtime'))).toBe(false);
    expect(existsSync(runtimeLogPath(root, appId, 'runtime_previous'))).toBe(false);
    expect((await testPool.query('SELECT count(*)::int AS n FROM runtime_logs WHERE app_id = $1', [appId])).rows[0].n).toBe(0);
    expect(existsSync(logFilePath(root, appId, depId, 'build'))).toBe(true);
    expect((await get(depId)).status).toBe(200);
  });

  test('another app keeps its runtime logs', async () => {
    const other = (await agent.post('/api/apps').send({ name: 'App B', repo: 'o/r', container_port: 3000, host_port: 8081 })).body.id;
    await writeRuntime(other, 'keep\n');
    await writeRuntime(appId, 'go\n');
    await del(appId);
    expect(existsSync(runtimeLogPath(root, other, 'runtime'))).toBe(true);
  });

  test('refused (409) while the app\'s output is still being collected', async () => {
    await writeRuntime(appId, lines(0, 5), { finished: false });
    await writeRuntime(appId, lines(0, 5), { kind: 'runtime_previous' });
    const res = await del(appId);
    expect(res.status).toBe(409);
    expect(existsSync(runtimeLogPath(root, appId, 'runtime'))).toBe(true);
    expect(existsSync(runtimeLogPath(root, appId, 'runtime_previous'))).toBe(true);
  });

  test('unknown ids are a 404, an app with nothing to delete is a 404, and deleting twice is a 404 the second time', async () => {
    expect((await del(ZERO)).status).toBe(404);
    expect((await del('not-a-uuid')).status).toBe(404);
    expect((await del(appId)).status).toBe(404);
    await writeRuntime(appId, lines(0, 2));
    expect((await del(appId)).status).toBe(200);
    expect((await del(appId)).status).toBe(404);
  });

  (process.getuid?.() === 0 ? test.skip : test)('files that cannot be removed give a clear error and keep the records', async () => {
    await writeRuntime(appId, lines(0, 3));
    const dir = join(root, appId);
    chmodSync(dir, 0o500);
    try {
      const res = await del(appId);
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/could not be deleted/i);
      expect(res.body.error).not.toContain(root);
      expect((await testPool.query('SELECT count(*)::int AS n FROM runtime_logs WHERE app_id = $1', [appId])).rows[0].n).toBe(1);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('DELETE /api/deployments/:id/logs', () => {
  test('needs a login', async () => {
    await writeLog(appId, depId, lines(0, 2));
    expect((await request(app).delete(`/api/deployments/${depId}/logs`)).status).toBe(401);
    expect(existsSync(logFilePath(root, appId, depId, 'build'))).toBe(true);
  });

  test('deletes the log files and their records, and says how much space it freed', async () => {
    await writeLog(appId, depId, lines(0, 10));
    const res = await agent.delete(`/api/deployments/${depId}/logs`);
    expect(res.status).toBe(200);
    expect(res.body.freedBytes).toBe(Buffer.byteLength(lines(0, 10)));
    expect(existsSync(logDirFor(root, appId, depId))).toBe(false);
    expect((await testPool.query('SELECT count(*)::int AS n FROM log_files WHERE deployment_id = $1', [depId])).rows[0].n).toBe(0);
    expect((await get(depId)).status).toBe(404);
  });

  test('only the deployment\'s own stored app decides what is removed, never anything in the request', async () => {
    const other = (await agent.post('/api/apps').send({ name: 'App B', repo: 'o/r', container_port: 3000, host_port: 8081 })).body.id;
    const otherDep = await deployment(other);
    await writeLog(other, otherDep, lines(0, 3));
    await writeLog(appId, depId, lines(0, 3));
    const res = await agent.delete(`/api/deployments/${depId}/logs?app=${other}&deployment=${otherDep}`);
    expect(res.status).toBe(200);
    expect(existsSync(logDirFor(root, appId, depId))).toBe(false);
    expect(existsSync(logDirFor(root, other, otherDep))).toBe(true);
  });

  test('the deployment itself, its status and its error summary stay', async () => {
    await testPool.query(`UPDATE deployments SET status = 'failed', error_summary = 'docker exited 1' WHERE id = $1`, [depId]);
    await writeLog(appId, depId, lines(0, 2));
    await agent.delete(`/api/deployments/${depId}/logs`);
    const d = (await testPool.query('SELECT status, error_summary FROM deployments WHERE id = $1', [depId])).rows[0];
    expect(d).toEqual({ status: 'failed', error_summary: 'docker exited 1' });
  });

  test('other deployments keep their logs', async () => {
    const other = await deployment(appId);
    await writeLog(appId, other, lines(0, 3));
    await writeLog(appId, depId, lines(0, 3));
    await agent.delete(`/api/deployments/${depId}/logs`);
    expect(existsSync(logFilePath(root, appId, other, 'build'))).toBe(true);
    expect((await get(other)).status).toBe(200);
  });

  test('deleting a deployment\'s logs never touches the app\'s runtime logs, running or not', async () => {
    await writeLog(appId, depId, lines(0, 2));
    await writeRuntime(appId, lines(0, 5), { finished: false });
    await writeRuntime(appId, lines(0, 6), { kind: 'runtime_previous' });
    const res = await agent.delete(`/api/deployments/${depId}/logs`);
    expect(res.status).toBe(200);
    expect(existsSync(logFilePath(root, appId, depId, 'build'))).toBe(false);
    expect(existsSync(runtimeLogPath(root, appId, 'runtime'))).toBe(true);
    expect(existsSync(runtimeLogPath(root, appId, 'runtime_previous'))).toBe(true);
    expect((await testPool.query('SELECT count(*)::int AS n FROM runtime_logs WHERE app_id = $1', [appId])).rows[0].n).toBe(2);
  });

  test('a deployment that is still running keeps its log: 409', async () => {
    for (const status of ['queued', 'building', 'starting', 'validating']) {
      const running = await deployment(appId, status);
      await writeLog(appId, running, lines(0, 2), { finished: false });
      expect((await agent.delete(`/api/deployments/${running}/logs`)).status).toBe(409);
      expect(existsSync(logFilePath(root, appId, running, 'build'))).toBe(true);
    }
  });

  // The log volume can be read-only or owned by someone else (a misconfigured mount). That must be a clear error that
  // leaves the records alone, not a bare 500 and not a record that claims the files are gone while they are not.
  (process.getuid?.() === 0 ? test.skip : test)('files that cannot be removed give a clear error and keep the records', async () => {
    await writeLog(appId, depId, lines(0, 3));
    const dir = logDirFor(root, appId, depId);
    chmodSync(dir, 0o500); // read and enter, but not delete
    try {
      const res = await agent.delete(`/api/deployments/${depId}/logs`);
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/could not be deleted/i);
      expect(res.body.error).not.toContain(root);
      expect((await testPool.query('SELECT count(*)::int AS n FROM log_files WHERE deployment_id = $1', [depId])).rows[0].n).toBe(1);
      expect(existsSync(logFilePath(root, appId, depId, 'build'))).toBe(true);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test('unknown ids and deployments with no log are a 404; deleting twice is a 404 the second time', async () => {
    expect((await agent.delete(`/api/deployments/${ZERO}/logs`)).status).toBe(404);
    expect((await agent.delete('/api/deployments/not-a-uuid/logs')).status).toBe(404);
    expect((await agent.delete(`/api/deployments/${depId}/logs`)).status).toBe(404);
    await writeLog(appId, depId, lines(0, 2));
    expect((await agent.delete(`/api/deployments/${depId}/logs`)).status).toBe(200);
    expect((await agent.delete(`/api/deployments/${depId}/logs`)).status).toBe(404);
  });
});

describe('GET /api/storage with runtime logs', () => {
  test('counts the runtime and previous-run files too, and a runtime log still being written by its size on disk', async () => {
    await writeLog(appId, depId, 'a'.repeat(100));
    await writeRuntime(appId, 'b'.repeat(2000), { finished: false });
    await writeRuntime(appId, 'c'.repeat(300), { kind: 'runtime_previous' });
    const { body } = await agent.get('/api/storage');
    expect(body.logs.totalBytes).toBe(2400);
    expect(body.logs.apps[0]).toMatchObject({ bytes: 2400, files: 3 });
  });
});

describe('GET /api/storage', () => {
  test('needs a login', async () => {
    expect((await request(app).get('/api/storage')).status).toBe(401);
  });

  test('with no logs at all: zero, and the disk figures', async () => {
    const { body } = await agent.get('/api/storage');
    expect(body.logs).toEqual({ totalBytes: 0, apps: [] });
    expect(body.disk).toMatchObject({ totalBytes: 100_000_000_000, freeBytes: 60_000_000_000, freePercent: 60, level: 'ok' });
  });

  test('adds up finished logs per app', async () => {
    const other = (await agent.post('/api/apps').send({ name: 'App B', repo: 'o/r', container_port: 3000, host_port: 8081 })).body.id;
    const d2 = await deployment(appId);
    const d3 = await deployment(other);
    await writeLog(appId, depId, 'a'.repeat(1000));
    await writeLog(appId, d2, 'b'.repeat(500));
    await writeLog(other, d3, 'c'.repeat(3000));
    const { body } = await agent.get('/api/storage');
    expect(body.logs.totalBytes).toBe(4500);
    const byApp = Object.fromEntries(body.logs.apps.map((a) => [a.slug, a]));
    expect(byApp['app-a']).toMatchObject({ appId, bytes: 1500, files: 2 });
    expect(byApp['app-b']).toMatchObject({ bytes: 3000, files: 1 });
    expect(body.logs.apps.map((a) => a.slug)).toEqual(['app-b', 'app-a']); // biggest first, although app B was written last
  });

  test('a log still being written counts by its size on disk, not by the zero in its record', async () => {
    await writeLog(appId, depId, 'x'.repeat(4321), { finished: false });
    expect((await agent.get('/api/storage')).body.logs.totalBytes).toBe(4321);
  });

  test.each([
    [60, 'ok'], [20, 'ok'], [19.9, 'low'], [10, 'low'], [9.9, 'critical'], [0.5, 'critical'],
  ])('with %s%% of the disk free the level is %s', async (pct, level) => {
    disk = { totalBytes: 1_000_000, freeBytes: Math.round((1_000_000 * pct) / 100) };
    const { body } = await agent.get('/api/storage');
    expect(body.disk.level).toBe(level);
    expect(body.disk.freePercent).toBeCloseTo(pct, 0);
  });

  test('if the disk cannot be measured the rest still works and says so', async () => {
    const broken = request.agent(await makeApp({ logDir: root, diskUsage: async () => { throw new Error('nope'); } }));
    await broken.post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    const { status, body } = await broken.get('/api/storage');
    expect(status).toBe(200);
    expect(body.disk).toBeNull();
    expect(body.logs.totalBytes).toBe(0);
  });
});
