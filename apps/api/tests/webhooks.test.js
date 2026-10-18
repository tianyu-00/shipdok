import request from 'supertest';
import { jest } from '@jest/globals';
import { createHmac, randomUUID } from 'node:crypto';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const REPO = 'tianyu-00/shipdok-test-app';
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const URL_PATH = '/api/webhooks/github';

let queue;
let app;
let agent; // logged-in admin, for creating apps and reading history
let appId;
let portCounter;

const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

// Sends a webhook the way GitHub would: raw JSON bytes, signature over exactly those bytes.
function deliver(payload, { a = app, event = 'push', delivery = randomUUID(), secret = SECRET, body, signature } = {}) {
  const raw = body ?? JSON.stringify(payload);
  let req = request(a).post(URL_PATH).set('Content-Type', 'application/json');
  if (event !== null) req = req.set('X-GitHub-Event', event);
  if (delivery !== null) req = req.set('X-GitHub-Delivery', delivery);
  const sig = signature === undefined ? sign(raw, secret) : signature;
  if (sig !== null) req = req.set('X-Hub-Signature-256', sig);
  return req.send(raw);
}

const push = (over = {}) => ({ ref: 'refs/heads/main', after: SHA, deleted: false, repository: { full_name: REPO }, ...over });
const rows = async (table) => (await testPool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
const count = async (table) => (await testPool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const deployments = async () => (await testPool.query('SELECT * FROM deployments ORDER BY seq')).rows;

async function createApp(over = {}) {
  portCounter += 1;
  const res = await agent.post('/api/apps').send({
    name: `App ${portCounter}`, repo: REPO, branch: 'main', container_port: 3000, host_port: 9000 + portCounter, ...over,
  });
  return res.body.id;
}

beforeEach(async () => {
  await resetDb();
  portCounter = 0;
  let jobs = 0;
  queue = { add: jest.fn(async () => ({ id: String(++jobs) })), remove: jest.fn(async () => {}) };
  app = await makeApp({ queue });
  agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  appId = await createApp();
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeDb);

describe('signature verification', () => {
  test('accepts a correctly signed delivery', async () => {
    const res = await deliver({ zen: 'hi' }, { event: 'ping' });
    expect(res.status).toBe(200);
  });

  test('uses the exact bytes received: odd spacing and unicode still verify', async () => {
    const body = '{"zen" :   "Keep it logically awesome — 日本語" ,\n"hook_id":1}';
    expect((await deliver(null, { event: 'ping', body })).status).toBe(200);
  });

  test.each([
    ['a missing signature', { signature: null }],
    ['an empty signature', { signature: '' }],
    ['the wrong secret', { secret: 'some-other-secret-0123456789' }],
    ['a signature with no prefix', { signature: createHmac('sha256', SECRET).update('{}').digest('hex') }],
    ['an old sha1 style signature', { signature: `sha1=${'a'.repeat(40)}` }],
    ['non-hex characters', { signature: `sha256=${'z'.repeat(64)}` }],
    ['a truncated signature', { signature: `sha256=${'a'.repeat(63)}` }],
    ['uppercase hex', { signature: `sha256=${createHmac('sha256', SECRET).update('{}').digest('hex').toUpperCase()}` }],
  ])('rejects %s', async (_label, opts) => {
    const res = await deliver({}, { event: 'ping', body: '{}', ...opts });
    expect(res.status).toBe(401);
  });

  test('a body changed after signing is rejected', async () => {
    const signature = sign('{"zen":"original"}');
    const res = await deliver(null, { event: 'ping', body: '{"zen":"tampered"}', signature });
    expect(res.status).toBe(401);
  });

  test('a push for a real app is rejected without a valid signature, and deploys nothing', async () => {
    const res = await deliver(push(), { signature: null });
    expect(res.status).toBe(401);
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('rejected requests leave no trace in the database', async () => {
    await deliver(push(), { secret: 'wrong-secret-0123456789abcdef' });
    await deliver(push(), { signature: null });
    expect(await count('webhook_deliveries')).toBe(0);
    expect(await count('deployments')).toBe(0);
  });

  test('without a configured secret the endpoint is disabled, even for a "valid" empty-secret signature', async () => {
    const disabled = await makeApp({ queue, webhookSecret: null });
    const body = JSON.stringify(push());
    const res = await request(disabled).post(URL_PATH).set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push').set('X-GitHub-Delivery', randomUUID())
      .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', '').update(body).digest('hex')}`).send(body);
    expect(res.status).toBe(503);
    expect(await count('webhook_deliveries')).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('oversized bodies are refused before anything else', async () => {
    const res = await deliver(null, { event: 'ping', body: JSON.stringify({ pad: 'x'.repeat(5 * 1024 * 1024 + 100) }) });
    expect(res.status).toBe(413);
  });

  test('needs no login, sets no cookie, and ignores the dashboard origin check', async () => {
    const res = await deliver({ zen: 'x' }, { event: 'ping' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('is rate limited', async () => {
    const limited = await makeApp({ queue, webhookRateLimit: 3 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await deliver({}, { a: limited, event: 'ping' })).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  // Behind the Cloudflare tunnel every connection comes from cloudflared on loopback; the real client is only
  // in X-Forwarded-For. Without trusting it, the whole internet shares one bucket and a flood locks GitHub out.
  test('counts each forwarded client separately when the proxy is on loopback', async () => {
    const limited = await makeApp({ queue, webhookRateLimit: 2 });
    const from = (ip) => deliver({}, { a: limited, event: 'ping' }).set('X-Forwarded-For', ip);
    const flood = [];
    for (let i = 0; i < 4; i++) flood.push((await from('203.0.113.7')).status);
    expect(flood).toEqual([200, 200, 429, 429]);
    expect((await from('198.51.100.9')).status).toBe(200);
  });

  test('a spoofed left-hand X-Forwarded-For entry does not buy a fresh bucket', async () => {
    const limited = await makeApp({ queue, webhookRateLimit: 2 });
    // The proxy appends the real client address on the right; anything the client put on the left is noise.
    const from = (spoof) => deliver({}, { a: limited, event: 'ping' }).set('X-Forwarded-For', `${spoof}, 203.0.113.7`);
    const codes = [];
    for (const spoof of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4']) codes.push((await from(spoof)).status);
    expect(codes).toEqual([200, 200, 429, 429]);
  });
});

describe('requests that are signed but malformed', () => {
  test.each([
    ['no delivery id', { delivery: null }],
    ['a delivery id with spaces', { delivery: 'has spaces in it!' }],
    ['a too-short delivery id', { delivery: 'abc' }],
    ['a too-long delivery id', { delivery: 'a'.repeat(65) }],
    ['no event', { event: null }],
    ['an uppercase event', { event: 'PUSH' }],
    ['an event with a space', { event: 'push now' }],
  ])('%s is a 400 and records nothing', async (_label, opts) => {
    const res = await deliver(push(), opts);
    expect(res.status).toBe(400);
    expect(await count('webhook_deliveries')).toBe(0);
  });

  test.each([
    ['not JSON', 'payload=%7B%7D'],
    ['a JSON array', '[1,2,3]'],
    ['JSON null', 'null'],
    ['a JSON string', '"hello"'],
    ['an empty body', ''],
  ])('a body that is %s is a 400 with a helpful message', async (_label, body) => {
    const res = await deliver(null, { body });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JSON object/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('a ping is recorded and answered', async () => {
    const delivery = randomUUID();
    const res = await deliver({ zen: 'x' }, { event: 'ping', delivery });
    expect(res.body).toEqual({ status: 'ignored', reason: 'ping' });
    const [row] = await rows('webhook_deliveries');
    expect(row).toMatchObject({ delivery_id: delivery, event: 'ping', outcome: 'ignored', reason: 'ping' });
  });

  test('events other than push are recorded and ignored', async () => {
    const res = await deliver({ action: 'opened' }, { event: 'issues' });
    expect(res.status).toBe(200);
    expect(res.body.reason).toMatch(/Unsupported event: issues/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('a push is a 503 when no queue is available, and nothing is recorded', async () => {
    const noQueue = await makeApp();
    const res = await deliver(push(), { a: noQueue });
    expect(res.status).toBe(503);
    expect(await count('webhook_deliveries')).toBe(0);
  });
});

describe('push handling', () => {
  test('deploys the pushed commit and records everything', async () => {
    const delivery = randomUUID();
    const res = await deliver(push(), { delivery });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('deployed');
    expect(res.body.deployments).toHaveLength(1);

    const [dep] = await deployments();
    expect(dep).toMatchObject({ app_id: appId, trigger: 'webhook', commit_sha: SHA, webhook_delivery_id: delivery, status: 'queued' });
    expect(res.body.deployments[0]).toBe(dep.id);

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [, job] = queue.add.mock.calls[0];
    expect(job).toMatchObject({
      deploymentId: dep.id, appId, ref: 'main', commit: SHA,
      repo: `https://github.com/${REPO}.git`, // built by the server, never taken from the payload
    });

    const [d] = await rows('webhook_deliveries');
    expect(d).toMatchObject({ outcome: 'deployed', repo: REPO, ref: 'main', commit_sha: SHA, event: 'push' });
    expect(d.details).toEqual([expect.objectContaining({ result: 'deployed', deploymentId: dep.id })]);
  });

  test.each([
    ['a push to another branch', { ref: 'refs/heads/feature' }, /No app tracks/],
    ['a tag', { ref: 'refs/tags/v1.0' }, /tag/],
    ['a non-branch ref', { ref: 'refs/pull/5/head' }, /Not a branch push/],
    ['a deleted branch (flag)', { deleted: true }, /deleted/],
    ['a deleted branch (zero commit)', { after: '0'.repeat(40) }, /deleted/],
    ['a repository nothing tracks', { repository: { full_name: 'someone/else' } }, /No app tracks/],
    ['a branch name of the wrong case', { ref: 'refs/heads/Main' }, /No app tracks/],
  ])('ignores %s', async (_label, over, reason) => {
    const res = await deliver(push(over));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toMatch(reason);
    expect(await count('deployments')).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('repository names match case-insensitively, as on GitHub', async () => {
    const res = await deliver(push({ repository: { full_name: 'TIANYU-00/Shipdok-Test-App' } }));
    expect(res.status).toBe(202);
  });

  test.each([
    ['a commit that is not hex', { after: 'xyz' }],
    ['a commit that is not a string', { after: 123 }],
    ['an uppercase commit', { after: 'A'.repeat(40) }],
    ['a commit of the wrong length', { after: 'a'.repeat(39) }],
    ['a missing ref', { ref: undefined }],
    ['a ref that is not a string', { ref: 5 }],
    ['a missing repository', { repository: undefined }],
    ['a repository that is not an object', { repository: 'x/y' }],
    ['a repository name that smuggles a command', { repository: { full_name: 'x/y;rm -rf /' } }],
    ['a branch that looks like a git option', { ref: 'refs/heads/--upload-pack=evil' }],
    ['an absurdly long branch name', { ref: `refs/heads/${'a'.repeat(300)}` }],
  ])('treats %s as malformed: ignored, recorded, never a server error', async (_label, over) => {
    const res = await deliver(push(over));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ignored', reason: 'Malformed push payload' });
    expect(await count('deployments')).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
    expect((await rows('webhook_deliveries'))[0].outcome).toBe('ignored');
  });

  test('every app tracking the same repository and branch is deployed', async () => {
    const second = await createApp({ name: 'Second' });
    const res = await deliver(push());
    expect(res.status).toBe(202);
    expect(res.body.deployments).toHaveLength(2);
    expect((await deployments()).map((d) => d.app_id).sort()).toEqual([appId, second].sort());
  });

  test('a stopped app is skipped with a recorded reason, and others still deploy', async () => {
    const stopped = await createApp({ name: 'Stopped' });
    await testPool.query(`UPDATE apps SET desired_state = 'stopped' WHERE id = $1`, [stopped]);
    const res = await deliver(push());
    expect(res.status).toBe(202);
    expect(res.body.deployments).toHaveLength(1);
    const [d] = await rows('webhook_deliveries');
    expect(d.details.find((x) => x.app === 'stopped')).toMatchObject({ result: 'skipped', reason: 'The app is stopped' });
    expect((await deployments()).every((x) => x.app_id !== stopped)).toBe(true);
  });

  test('when every tracking app is stopped nothing deploys and the reason is explained', async () => {
    await testPool.query(`UPDATE apps SET desired_state = 'stopped'`);
    const res = await deliver(push());
    expect(res.status).toBe(200);
    expect(res.body.reason).toMatch(/stopped/);
    expect(await count('deployments')).toBe(0);
  });

  test('two quick pushes: the older deployment is superseded and the newest keeps its own commit', async () => {
    await deliver(push({ after: SHA }));
    await deliver(push({ after: SHA2 }));
    const [older, newer] = await deployments();
    expect(older).toMatchObject({ status: 'superseded', superseded_by: newer.id, commit_sha: SHA });
    expect(newer).toMatchObject({ status: 'queued', commit_sha: SHA2 });
    expect(queue.add.mock.calls.map(([, j]) => j.commit)).toEqual([SHA, SHA2]);
  });
});

describe('duplicates and retries', () => {
  test('the same delivery sent twice deploys once', async () => {
    const delivery = randomUUID();
    expect((await deliver(push(), { delivery })).status).toBe(202);
    const again = await deliver(push(), { delivery });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ status: 'duplicate' });
    expect(await count('deployments')).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  test('simultaneous copies of one delivery create exactly one deployment', async () => {
    const delivery = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver(push(), { delivery })));
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.body.status === 'duplicate')).toHaveLength(5);
    expect(await count('deployments')).toBe(1);
  });

  test('a delivery that failed to enqueue can be redelivered and then succeeds', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const delivery = randomUUID();
    queue.add.mockRejectedValueOnce(new Error('redis is down'));
    const first = await deliver(push(), { delivery });
    expect(first.status).toBe(503);
    expect((await rows('webhook_deliveries'))[0]).toMatchObject({ outcome: 'error' });

    const second = await deliver(push(), { delivery });
    expect(second.status).toBe(202);
    expect((await rows('webhook_deliveries'))[0].outcome).toBe('deployed');
    const all = await deployments();
    expect(all.map((d) => d.status).sort()).toEqual(['failed', 'queued']);
  });

  test('a partial failure is retried without duplicating the app that already deployed', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const second = await createApp({ name: 'Second' });
    const delivery = randomUUID();
    let calls = 0;
    queue.add.mockImplementation(async () => { calls += 1; if (calls === 2) throw new Error('boom'); return { id: String(calls) }; });

    expect((await deliver(push(), { delivery })).status).toBe(503);
    const retry = await deliver(push(), { delivery });
    expect(retry.status).toBe(202);

    const all = await deployments();
    const forFirst = all.filter((d) => d.app_id === appId && d.status !== 'superseded');
    const forSecond = all.filter((d) => d.app_id === second);
    expect(forFirst).toHaveLength(1); // not deployed twice
    expect(forSecond.map((d) => d.status).sort()).toEqual(['failed', 'queued']); // the failed attempt, then the retry
    const [d] = await rows('webhook_deliveries');
    expect(d.outcome).toBe('deployed');
    expect(d.details.map((x) => x.result).sort()).toEqual(['already-deployed', 'deployed']);
  });

  test('a delivery whose first attempt died mid-flight (over 5 minutes ago) can be taken over', async () => {
    const delivery = randomUUID();
    await testPool.query(
      `INSERT INTO webhook_deliveries (delivery_id, event, outcome, received_at) VALUES ($1, 'push', 'processing', now() - interval '10 minutes')`, [delivery]);
    expect((await deliver(push(), { delivery })).status).toBe(202);
  });

  test('a delivery that is genuinely still being processed is not taken over', async () => {
    const delivery = randomUUID();
    await testPool.query(`INSERT INTO webhook_deliveries (delivery_id, event, outcome) VALUES ($1, 'push', 'processing')`, [delivery]);
    const res = await deliver(push(), { delivery });
    expect(res.body).toEqual({ status: 'duplicate' });
    expect(await count('deployments')).toBe(0);
  });

  test('a delivery already ignored stays ignored on redelivery', async () => {
    const delivery = randomUUID();
    await deliver(push({ ref: 'refs/heads/feature' }), { delivery });
    const again = await deliver(push(), { delivery }); // even if the app would match now
    expect(again.body).toEqual({ status: 'duplicate' });
    expect(await count('deployments')).toBe(0);
  });
});

describe('delivery history', () => {
  test('requires a login', async () => {
    expect((await request(app).get('/api/webhooks/deliveries')).status).toBe(401);
  });

  test('lists recent deliveries newest first, explaining each outcome', async () => {
    await deliver(push({ ref: 'refs/heads/feature' }));
    await deliver(push());
    const res = await agent.get('/api/webhooks/deliveries');
    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.outcome)).toEqual(['deployed', 'ignored']);
    expect(res.body[1].reason).toMatch(/No app tracks/);
  });

  test('never contains the secret or the payload', async () => {
    await deliver({ ...push(), sender: { login: 'someone' }, head_commit: { message: 'private commit message' } });
    const res = await agent.get('/api/webhooks/deliveries');
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toContain('private commit message');
    expect(res.text).not.toContain('someone');
  });
});

describe('migration 006', () => {
  test('at most one deployment per (delivery, app)', async () => {
    const delivery = randomUUID();
    await testPool.query(`INSERT INTO webhook_deliveries (delivery_id, event, outcome) VALUES ($1, 'push', 'deployed')`, [delivery]);
    const insert = () => testPool.query(
      `INSERT INTO deployments (app_id, trigger, webhook_delivery_id, config_snapshot) VALUES ($1, 'webhook', $2, '{}')`, [appId, delivery]);
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
  });

  test('deployments without a delivery are unconstrained', async () => {
    const insert = () => testPool.query(`INSERT INTO deployments (app_id, trigger, config_snapshot) VALUES ($1, 'manual', '{}')`, [appId]);
    await insert();
    await insert();
    expect(await count('deployments')).toBe(2);
  });

  test('deleting a delivery keeps the deployment and clears the link', async () => {
    const delivery = randomUUID();
    await deliver(push(), { delivery });
    await testPool.query('DELETE FROM webhook_deliveries WHERE delivery_id = $1', [delivery]);
    const [dep] = await deployments();
    expect(dep.webhook_delivery_id).toBeNull();
  });

  test.each([
    ['an unknown outcome', `('abcdefgh', 'push', 'maybe')`],
    ['an invalid delivery id', `('bad id!', 'push', 'ignored')`],
    ['an invalid event name', `('abcdefgh', 'PUSH', 'ignored')`],
  ])('rejects %s', async (_label, values) => {
    await expect(testPool.query(`INSERT INTO webhook_deliveries (delivery_id, event, outcome) VALUES ${values}`))
      .rejects.toMatchObject({ code: '23514' });
  });
});
