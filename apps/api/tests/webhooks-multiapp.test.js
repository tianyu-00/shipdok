// The webhook receiver with several GitHub Apps: each has its own secret, and a push deploys only the projects assigned to the app that sent it.
import request from 'supertest';
import { jest } from '@jest/globals';
import { createHmac, randomUUID, generateKeyPairSync } from 'node:crypto';
import { createGithubProvider, parseMasterKey, saveGithubApp } from '@shipdok/shared';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

const KEY = parseMasterKey('a1'.repeat(32));
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const SECRET_A = 'secret-of-the-first-app-0123456789';
const SECRET_B = 'secret-of-the-second-app-9876543210';
const REPO = 'tianyu-00/shipdok-test-app';
const SHA = 'a'.repeat(40);
const PATH = '/api/webhooks/github';

let queue;
let app;
let agent;
let a; // Shipdok's id for the first GitHub App
let b; // ... the second
let port;

const sign = (raw, secret) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const push = (over = {}) => ({ ref: 'refs/heads/main', after: SHA, deleted: false, repository: { full_name: REPO }, ...over });
const deliver = (payload, secret, { event = 'push' } = {}) => {
  const raw = JSON.stringify(payload);
  return request(app).post(PATH).set('Content-Type', 'application/json').set('X-GitHub-Event', event).set('X-GitHub-Delivery', randomUUID()).set('X-Hub-Signature-256', sign(raw, secret)).send(raw);
};
async function project(name, { githubApp = null, repo = REPO, branch = 'main' } = {}) {
  port += 1;
  const res = await agent.post('/api/apps').send({ name, repo, branch, container_port: 3000, host_port: 9300 + port, github_app_id: githubApp });
  return res.body.id;
}
const queued = () => queue.add.mock.calls.map((c) => c[1].appId);
const lastDelivery = async () => (await testPool.query('SELECT outcome, reason, details FROM webhook_deliveries ORDER BY received_at DESC LIMIT 1')).rows[0];

beforeEach(async () => {
  await resetDb();
  port = 0;
  let jobs = 0;
  queue = { add: jest.fn(async () => ({ id: String(++jobs) })), remove: jest.fn(async () => {}) };
  a = (await saveGithubApp(testPool, KEY, { appId: '111', name: 'First', privateKeyPem: PEM, webhookSecret: SECRET_A, source: 'manual' })).id;
  b = (await saveGithubApp(testPool, KEY, { appId: '222', name: 'Second', privateKeyPem: PEM, webhookSecret: SECRET_B, source: 'manual' })).id;
  const githubProvider = createGithubProvider(testPool, KEY, { ttlMs: 0, fetch: async () => new Response('{}', { status: 404 }) });
  app = await makeApp({ queue, githubProvider });
  agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await resetDb();
  await closeDb();
});

describe('which secret signed it', () => {
  test('a delivery signed with the first app\'s secret is believed, and so is the second\'s', async () => {
    expect((await deliver({ zen: 'hi' }, SECRET_A, { event: 'ping' })).status).toBe(200);
    expect((await deliver({ zen: 'hi' }, SECRET_B, { event: 'ping' })).status).toBe(200);
  });

  test('a secret no connected app has is refused, and nothing is recorded', async () => {
    const res = await deliver(push(), 'a-secret-nobody-has-0123456789');
    expect(res.status).toBe(401);
    expect((await testPool.query('SELECT count(*)::int AS n FROM webhook_deliveries')).rows[0].n).toBe(0);
  });

  test('a secret that was an app\'s, until it was disconnected, no longer works', async () => {
    await testPool.query('DELETE FROM github_apps WHERE id = $1', [a]);
    expect((await deliver(push(), SECRET_A)).status).toBe(401);
    expect((await deliver(push(), SECRET_B)).status).toBe(200);
  });
});

describe('a push deploys the projects of the app that sent it', () => {
  test('a push from the first app deploys its project and not the second app\'s project for the same repository and branch', async () => {
    const one = await project('one', { githubApp: a });
    const two = await project('two', { githubApp: b });
    const res = await deliver(push(), SECRET_A);
    expect([res.status, res.body.status]).toEqual([202, 'deployed']);
    expect(queued()).toEqual([one]);
    const second = await deliver(push({ after: 'b'.repeat(40) }), SECRET_B);
    expect(second.body.status).toBe('deployed');
    expect(queued()).toEqual([one, two]);
  });

  test('two projects of the same app tracking the same repository and branch are both deployed', async () => {
    const one = await project('one', { githubApp: a });
    const two = await project('two', { githubApp: a });
    await deliver(push(), SECRET_A);
    expect(queued().sort()).toEqual([one, two].sort());
  });

  test('a project with no GitHub app is never deployed by a push from any app', async () => {
    await project('manual-only', { githubApp: null });
    const res = await deliver(push(), SECRET_A);
    expect(res.body.status).toBe('ignored');
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('the history says why: the project uses a different app (so the cause can be found), or that no project tracks it', async () => {
    await project('two', { githubApp: b });
    const wrongApp = await deliver(push(), SECRET_A);
    expect([wrongApp.status, wrongApp.body.status]).toEqual([200, 'ignored']);
    expect(wrongApp.body.reason).toMatch(/different GitHub app/);
    expect((await lastDelivery()).reason).toMatch(/different GitHub app/);
    const nobody = await deliver(push({ repository: { full_name: 'someone/else' } }), SECRET_A);
    expect(nobody.body.reason).toBe('No app tracks this repository and branch');
  });

  test('the branch still matters', async () => {
    await project('main-one', { githubApp: a, branch: 'main' });
    const res = await deliver(push({ ref: 'refs/heads/other' }), SECRET_A);
    expect(res.body.status).toBe('ignored');
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('moving a project to another app moves which app\'s pushes deploy it', async () => {
    const one = await project('one', { githubApp: a });
    await agent.put(`/api/apps/${one}`).send({ github_app_id: b });
    expect((await deliver(push(), SECRET_A)).body.status).toBe('ignored');
    expect((await deliver(push({ after: 'c'.repeat(40) }), SECRET_B)).body.status).toBe('deployed');
    expect(queued()).toEqual([one]);
  });

  test('the job carries the project\'s GitHub app, so the worker clones with the right one', async () => {
    await project('one', { githubApp: b });
    await deliver(push(), SECRET_B);
    expect(queue.add.mock.calls[0][1].githubAppId).toBe(b);
  });
});
