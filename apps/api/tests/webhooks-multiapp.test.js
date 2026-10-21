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

describe('a refused delivery leaves one line in the log saying who sent it', () => {
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  const bad = (headers = {}, secret = 'a-secret-nobody-has-0123456789') => {
    const raw = JSON.stringify(push());
    let req = request(app).post(PATH).set('Content-Type', 'application/json').set('X-GitHub-Event', 'push').set('X-GitHub-Delivery', randomUUID()).set('X-Hub-Signature-256', sign(raw, secret));
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req.send(raw);
  };
  const lines = () => warn.mock.calls.map((c) => String(c[0]));

  test('an app Shipdok has, whose secret does not match: names the app and says what to do', async () => {
    const res = await bad({ 'X-GitHub-Hook-Installation-Target-ID': '111' });
    expect(res.status).toBe(401);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/GitHub App ID 111/);
    expect(lines()[0]).toMatch(/does not match the webhook secret stored for First/);
    expect(lines()[0]).toMatch(/same webhook secret on GitHub and in Shipdok/);
  });

  test('an app Shipdok does not have: says so and says where to add it', async () => {
    await bad({ 'X-GitHub-Hook-Installation-Target-ID': '999' });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/GitHub App ID 999/);
    expect(lines()[0]).toMatch(/no connected GitHub app with that ID/);
    expect(lines()[0]).toMatch(/Add a GitHub app/);
  });

  test('no header at all: still one line, saying GitHub did not say which app', async () => {
    await bad();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/did not say which app sent it/);
  });

  test.each([['not-a-number'], ['12 34'], ['1'.repeat(21)], ['111; DROP TABLE'], ['<script>x</script>']])('a header that is not a plain number (%j) is treated as no header, and never appears in the log', async (value) => {
    await bad({ 'X-GitHub-Hook-Installation-Target-ID': value });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/did not say which app sent it/);
    expect(lines()[0]).not.toContain(value);
  });

  test('never the signature, the body or a secret', async () => {
    await bad({ 'X-GitHub-Hook-Installation-Target-ID': '111' }, 'a-secret-nobody-has-0123456789');
    const all = lines().join('\n');
    expect(all).not.toContain('a-secret-nobody-has-0123456789');
    expect(all).not.toContain(SECRET_A);
    expect(all).not.toContain(SECRET_B);
    expect(all).not.toMatch(/sha256=|refs\/heads|tianyu-00/);
  });

  test('a flood from one sender is one line a minute; another sender has its own line; later the first speaks again', async () => {
    const real = Date.now();
    let offset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => real + offset);
    for (let i = 0; i < 5; i += 1) await bad({ 'X-GitHub-Hook-Installation-Target-ID': '111' });
    expect(lines()).toHaveLength(1);
    await bad({ 'X-GitHub-Hook-Installation-Target-ID': '222' });
    await bad();
    expect(lines()).toHaveLength(3);
    offset = 61_000;
    await bad({ 'X-GitHub-Hook-Installation-Target-ID': '111' });
    expect(lines()).toHaveLength(4);
  });

  test('the memory of who was logged is bounded: after 100 different senders it starts again, so it cannot grow without end', async () => {
    for (let i = 1; i <= 101; i += 1) await bad({ 'X-GitHub-Hook-Installation-Target-ID': String(1000 + i) });
    expect(lines()).toHaveLength(101);
    await bad({ 'X-GitHub-Hook-Installation-Target-ID': '1001' }); // the first sender again, within the minute: forgotten, so it is logged again
    expect(lines()).toHaveLength(102);
    await bad({ 'X-GitHub-Hook-Installation-Target-ID': '1001' }); // but now remembered again
    expect(lines()).toHaveLength(102);
  })

  test('a delivery that is signed properly is not logged', async () => {
    await deliver(push(), SECRET_A);
    expect(warn).not.toHaveBeenCalled();
  });

  test('with no GitHub app connected at all (503) nothing is logged: that is not a wrong signature', async () => {
    await testPool.query('DELETE FROM github_apps');
    const res = await bad({ 'X-GitHub-Hook-Installation-Target-ID': '111' });
    expect(res.status).toBe(503);
    expect(warn).not.toHaveBeenCalled();
  });

  test('the answer to GitHub is the same plain 401 whatever the header says (the log is the only difference)', async () => {
    const a = await bad({ 'X-GitHub-Hook-Installation-Target-ID': '111' });
    const b = await bad({ 'X-GitHub-Hook-Installation-Target-ID': '999' });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body).toEqual(b.body);
  });
});

describe('what the dashboard is told about refused pushes (GET /api/github)', () => {
  beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  const bad = (id, secret = 'a-secret-nobody-has-0123456789') => {
    const raw = JSON.stringify(push());
    let req = request(app).post(PATH).set('Content-Type', 'application/json').set('X-GitHub-Event', 'push').set('X-GitHub-Delivery', randomUUID()).set('X-Hub-Signature-256', sign(raw, secret));
    if (id !== undefined) req = req.set('X-GitHub-Hook-Installation-Target-ID', id);
    return req.send(raw);
  };
  const status = async () => (await agent.get('/api/github')).body;
  const appOf = (body, name) => body.apps.find((x) => x.name === name);

  test('nothing refused: no warning anywhere', async () => {
    const body = await status();
    expect(body.unknownSenders).toEqual([]);
    expect(body.apps.map((x) => x.refusedPush)).toEqual([null, null]);
  });

  test('a push refused from a connected app shows on that app, with how many and when, and nowhere else', async () => {
    await bad('111');
    await bad('111');
    const body = await status();
    expect(appOf(body, 'First').refusedPush).toMatchObject({ count: 2 });
    expect(new Date(appOf(body, 'First').refusedPush.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(appOf(body, 'Second').refusedPush).toBeNull();
    expect(body.unknownSenders).toEqual([]);
  });

  test('a push from an app that is not connected is an unknown sender, by its number', async () => {
    await bad('999');
    const body = await status();
    expect(body.unknownSenders).toMatchObject([{ appNumber: '999', count: 1 }]);
    expect(body.apps.map((x) => x.refusedPush)).toEqual([null, null]);
  });

  test('a push that did not say who sent it is an unknown sender with no number', async () => {
    await bad(undefined);
    expect((await status()).unknownSenders).toMatchObject([{ appNumber: null, count: 1 }]);
  });

  test('a good push from that app clears its warning; the others stay', async () => {
    await bad('111');
    await bad('222');
    await bad('999');
    await deliver(push({ ref: 'refs/heads/other' }), SECRET_A, { event: 'push' });
    const body = await status();
    expect(appOf(body, 'First').refusedPush).toBeNull();
    expect(appOf(body, 'Second').refusedPush).not.toBeNull();
    expect(body.unknownSenders).toHaveLength(1);
  });

  test('a ping signed properly also clears it', async () => {
    await bad('222');
    await deliver({ zen: 'x' }, SECRET_B, { event: 'ping' });
    expect(appOf(await status(), 'Second').refusedPush).toBeNull();
  });

  test('a refused push is not recorded when no GitHub app is connected at all (that is a 503, not a wrong signature)', async () => {
    await testPool.query('DELETE FROM github_apps');
    await bad('111');
    expect((await status()).unknownSenders).toEqual([]);
  });

  test('it needs a login', async () => {
    await bad('999');
    expect((await request(app).get('/api/github')).status).toBe(401);
  });

  test('what is shown holds only a number, a time and a count: nothing from the request', async () => {
    await bad('999');
    const body = JSON.stringify((await status()).unknownSenders);
    expect(body).not.toMatch(/sha256|refs\/heads|tianyu-00|a-secret/);
    expect(Object.keys(JSON.parse(body)[0]).sort()).toEqual(['appNumber', 'at', 'count']);
  });
});
