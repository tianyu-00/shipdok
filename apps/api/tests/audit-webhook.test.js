// A push that deploys an app is recorded in the activity log as something Shipdok did by itself (source webhook): hidden unless asked for.
import request from 'supertest';
import { jest } from '@jest/globals';
import { createHmac, randomUUID } from 'node:crypto';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const REPO = 'tianyu-00/shipdok-test-app';
const SHA = 'a1b2c3d4'.repeat(5);
let app;
let agent;
let appId;

const deliver = (payload) => {
  const raw = JSON.stringify(payload);
  return request(app).post('/api/webhooks/github').set('Content-Type', 'application/json').set('X-GitHub-Event', 'push').set('X-GitHub-Delivery', randomUUID())
    .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`).send(raw);
};
const push = (over = {}) => ({ ref: 'refs/heads/main', after: SHA, deleted: false, repository: { full_name: REPO }, ...over });
const entries = async (q = '') => (await agent.get(`/api/audit?limit=500${q}`)).body.entries;

beforeEach(async () => {
  await resetDb();
  let jobs = 0;
  app = await makeApp({ queue: { add: jest.fn(async () => ({ id: String(++jobs) })), remove: jest.fn(async () => {}) } });
  agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  appId = (await agent.post('/api/apps').send({ name: 'Site', repo: REPO, branch: 'main', container_port: 3000, host_port: 9101 })).body.id;
});
afterAll(closeDb);

test('a push that deploys is an automatic entry: not in the default list, there with automatic=1, with the commit and the deployment', async () => {
  const res = await deliver(push());
  expect(res.body.status).toBe('deployed');
  expect((await entries()).filter((e) => e.action === 'deploy_webhook')).toEqual([]);
  const e = (await entries('&automatic=1')).find((x) => x.action === 'deploy_webhook');
  expect(e).toMatchObject({ category: 'deployments', source: 'webhook', actor: 'GitHub', summary: 'Push to main deployed Site', appId, appName: 'Site' });
  expect(e.details).toContainEqual({ label: 'Commit', value: SHA.slice(0, 8) });
  expect(e.details).toContainEqual({ label: 'Deployment', value: res.body.deployments[0].slice(0, 8) });
  expect(e.details).toContainEqual({ label: 'Repository', value: REPO });
});

test('a push that is ignored (another branch, a stopped app) or a repeat leaves no entry', async () => {
  await deliver(push({ ref: 'refs/heads/other' }));
  await agent.post(`/api/apps/${appId}/stop`);
  await deliver(push());
  expect((await entries('&automatic=1')).filter((e) => e.action === 'deploy_webhook')).toEqual([]);
});

test('a refused signature leaves no entry', async () => {
  const raw = JSON.stringify(push());
  const res = await request(app).post('/api/webhooks/github').set('Content-Type', 'application/json').set('X-GitHub-Event', 'push').set('X-GitHub-Delivery', randomUUID()).set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64)).send(raw);
  expect(res.status).toBe(401);
  expect((await entries('&automatic=1')).filter((e) => e.action === 'deploy_webhook')).toEqual([]);
});
