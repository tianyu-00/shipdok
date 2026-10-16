import request from 'supertest';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let queue;
let app;
let agent;
let appA;
let appB;
let jobCounter;

beforeEach(async () => {
  await resetDb();
  jobCounter = 0;
  queue = {
    add: jest.fn(async () => ({ id: String(++jobCounter) })),
    remove: jest.fn(async () => {}),
  };
  app = await makeApp({ queue });
  agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  const mk = (name, port) => agent.post('/api/apps').send({ name, repo: 'o/r', container_port: 3000, host_port: port }).then((r) => r.body.id);
  appA = await mk('App A', 8080);
  appB = await mk('App B', 8081);
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeDb);

const deploy = async (id) => (await agent.post(`/api/apps/${id}/deployments`)).body;
const row = async (id) => (await testPool.query('SELECT * FROM deployments WHERE id = $1', [id])).rows[0];
const setStatus = (id, status) => testPool.query('UPDATE deployments SET status = $2 WHERE id = $1', [id, status]);
const cancel = (id) => agent.post(`/api/deployments/${id}/cancel`);

describe('a new deployment supersedes older ones of the same app', () => {
  test('older queued deployments end as superseded, each pointing at the deployment that replaced it', async () => {
    const d1 = await deploy(appA);
    const d2 = await deploy(appA);
    const d3 = await deploy(appA);

    // A chain: d1 was replaced by d2, and d2 by d3. d1 is already finished when d3 arrives, so it is not touched again.
    for (const [old, replacedBy] of [[d1, d2], [d2, d3]]) {
      const r = await row(old.id);
      expect(r).toMatchObject({ status: 'superseded', cancel_status: 'superseded', superseded_by: replacedBy.id });
      expect(r.finished_at).not.toBeNull();
      expect(r.error_summary).toMatch(/superseded/i);
    }
    expect(await row(d3.id)).toMatchObject({ status: 'queued', cancel_status: null, superseded_by: null });
  });

  test('their jobs are removed from the queue, but a Redis failure does not fail the request', async () => {
    const d1 = await deploy(appA);
    await deploy(appA);
    expect(queue.remove).toHaveBeenCalledWith(String(d1.job_id));

    queue.remove.mockRejectedValue(new Error('job is active, cannot remove'));
    const res = await agent.post(`/api/apps/${appA}/deployments`);
    expect(res.status).toBe(202);
  });

  test('a running build is only flagged: its status is untouched until the worker has cleaned up', async () => {
    const d1 = await deploy(appA);
    await setStatus(d1.id, 'building');
    const d2 = await deploy(appA);

    const r = await row(d1.id);
    expect(r.status).toBe('building');
    expect(r.cancel_status).toBe('superseded');
    expect(r.superseded_by).toBe(d2.id);
    expect(r.finished_at).toBeNull();
    expect(queue.remove).not.toHaveBeenCalledWith(String(d1.job_id)); // a running job is not yanked from Redis
  });

  test.each(['building', 'starting', 'validating'])('flags a deployment that is %s', async (status) => {
    const d1 = await deploy(appA);
    await setStatus(d1.id, status);
    await deploy(appA);
    expect((await row(d1.id)).cancel_status).toBe('superseded');
  });

  test("another app's queued deployment is never superseded", async () => {
    const b = await deploy(appB); // still queued, and the newest of app B
    await deploy(appA);
    await deploy(appA);
    expect(await row(b.id)).toMatchObject({ status: 'queued', cancel_status: null, superseded_by: null, finished_at: null });
  });

  test("another app's running deployment is never flagged", async () => {
    const b = await deploy(appB);
    await setStatus(b.id, 'building');
    await deploy(appA);
    await deploy(appA);
    expect(await row(b.id)).toMatchObject({ status: 'building', cancel_status: null, superseded_by: null });
  });

  test('each app keeps its own latest deployment independently', async () => {
    const a1 = await deploy(appA);
    const b1 = await deploy(appB);
    const a2 = await deploy(appA);
    const b2 = await deploy(appB);
    expect((await row(a1.id)).superseded_by).toBe(a2.id);
    expect((await row(b1.id)).superseded_by).toBe(b2.id);
    expect((await row(a2.id)).status).toBe('queued');
    expect((await row(b2.id)).status).toBe('queued');
  });

  test.each(['successful', 'failed', 'cancelled', 'interrupted'])('a finished %s deployment is left exactly as it was', async (status) => {
    const d1 = await deploy(appA);
    await testPool.query(`UPDATE deployments SET status = $2, finished_at = now() WHERE id = $1`, [d1.id, status]);
    await deploy(appA);
    expect(await row(d1.id)).toMatchObject({ status, cancel_status: null, superseded_by: null });
  });

  test('an explicit cancel is never downgraded to superseded', async () => {
    const d1 = await deploy(appA);
    await setStatus(d1.id, 'building');
    await cancel(d1.id);
    await deploy(appA);
    expect(await row(d1.id)).toMatchObject({ cancel_status: 'cancelled', superseded_by: null });
  });

  test('concurrent requests leave exactly one survivor: the highest seq', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => agent.post(`/api/apps/${appA}/deployments`)));
    expect(results.every((r) => r.status === 202)).toBe(true);

    const { rows } = await testPool.query('SELECT id, seq::int AS seq, status, superseded_by FROM deployments WHERE app_id = $1 ORDER BY seq', [appA]);
    const survivors = rows.filter((r) => r.status === 'queued');
    expect(survivors).toHaveLength(1);
    expect(survivors[0].seq).toBe(Math.max(...rows.map((r) => r.seq)));
    const bySeq = new Map(rows.map((r) => [r.id, r.seq]));
    for (const r of rows.filter((x) => x.status === 'superseded')) {
      expect(bySeq.get(r.superseded_by)).toBeGreaterThan(r.seq); // always replaced by something NEWER
    }
  });

  test('if enqueueing fails, older queued deployments are left alone', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const d1 = await deploy(appA);
    queue.add.mockRejectedValueOnce(new Error('redis is down'));
    const res = await agent.post(`/api/apps/${appA}/deployments`);
    expect(res.status).toBe(503);
    expect(await row(d1.id)).toMatchObject({ status: 'queued', cancel_status: null, superseded_by: null });
  });

  test('the new fields are visible through the API', async () => {
    const d1 = await deploy(appA);
    const d2 = await deploy(appA);
    const one = (await agent.get(`/api/deployments/${d1.id}`)).body;
    expect(one).toMatchObject({ status: 'superseded', cancel_status: 'superseded', superseded_by: d2.id });
    const list = (await agent.get(`/api/apps/${appA}/deployments`)).body;
    expect(list.map((d) => d.status)).toEqual(['queued', 'superseded']);
  });
});

describe('POST /api/deployments/:id/cancel', () => {
  test('a queued deployment is cancelled immediately (200) and its job removed', async () => {
    const d = await deploy(appA);
    const res = await cancel(d.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', cancel_status: 'cancelled' });
    expect(res.body.finished_at).not.toBeNull();
    expect(res.body.error_summary).toMatch(/administrator/i);
    expect(queue.remove).toHaveBeenCalledWith(String(d.job_id));
  });

  test.each(['building', 'starting', 'validating'])('a %s deployment is only asked to stop (202)', async (status) => {
    const d = await deploy(appA);
    await setStatus(d.id, status);
    const res = await cancel(d.id);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status, cancel_status: 'cancelled', finished_at: null });
  });

  test('asking twice is harmless', async () => {
    const d = await deploy(appA);
    await setStatus(d.id, 'building');
    expect((await cancel(d.id)).status).toBe(202);
    expect((await cancel(d.id)).status).toBe(202);
    expect((await row(d.id)).cancel_status).toBe('cancelled');
  });

  test('a deployment already being superseded keeps that outcome', async () => {
    const d1 = await deploy(appA);
    await setStatus(d1.id, 'building');
    await deploy(appA);
    expect((await cancel(d1.id)).status).toBe(202);
    expect((await row(d1.id)).cancel_status).toBe('superseded');
  });

  test.each(['successful', 'failed', 'cancelled', 'superseded', 'interrupted'])('a %s deployment cannot be cancelled (409) and is unchanged', async (status) => {
    const d = await deploy(appA);
    await testPool.query(`UPDATE deployments SET status = $2, finished_at = now() WHERE id = $1`, [d.id, status]);
    const before = await row(d.id);
    const res = await cancel(d.id);
    expect(res.status).toBe(409);
    expect(await row(d.id)).toEqual(before);
  });

  test('unknown and malformed ids are 404', async () => {
    expect((await cancel('00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await cancel('not-a-uuid')).status).toBe(404);
  });

  test('requires a session', async () => {
    const d = await deploy(appA);
    expect((await request(app).post(`/api/deployments/${d.id}/cancel`)).status).toBe(401);
    expect((await row(d.id)).status).toBe('queued');
  });

  test('a foreign origin is rejected and nothing changes', async () => {
    const d = await deploy(appA);
    const res = await agent.post(`/api/deployments/${d.id}/cancel`).set('Origin', 'http://evil.example');
    expect(res.status).toBe(403);
    expect((await row(d.id)).status).toBe('queued');
  });

  test('a Redis failure while removing the job does not fail the cancel', async () => {
    const d = await deploy(appA);
    queue.remove.mockRejectedValueOnce(new Error('redis is down'));
    expect((await cancel(d.id)).status).toBe(200);
    expect((await row(d.id)).status).toBe('cancelled');
  });
});

describe('migration 005', () => {
  test('seq is unique and strictly increasing', async () => {
    const a = await deploy(appA);
    const b = await deploy(appB);
    const c = await deploy(appA);
    const { rows } = await testPool.query('SELECT id, seq::int AS seq FROM deployments');
    const seq = Object.fromEntries(rows.map((r) => [r.id, r.seq]));
    expect(seq[a.id]).toBeLessThan(seq[b.id]);
    expect(seq[b.id]).toBeLessThan(seq[c.id]);
  });

  test('cancel_status only accepts known values', async () => {
    const d = await deploy(appA);
    await expect(testPool.query(`UPDATE deployments SET cancel_status = 'bogus' WHERE id = $1`, [d.id]))
      .rejects.toMatchObject({ code: '23514' });
  });

  test('deleting the superseding deployment clears the link instead of blocking', async () => {
    const d1 = await deploy(appA);
    const d2 = await deploy(appA);
    await testPool.query('DELETE FROM deployments WHERE id = $1', [d2.id]);
    expect((await row(d1.id)).superseded_by).toBeNull();
  });
});
