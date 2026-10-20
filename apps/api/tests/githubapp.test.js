import request from 'supertest';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';
import { saveGithubApp, parseMasterKey } from '@shipdok/shared';
import { generateKeyPairSync } from 'node:crypto';

let queue, agent, github, app, ghId;
const KEY = parseMasterKey(process.env.APP_SECRETS_KEY ?? 'a1'.repeat(32));
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const REPO = 'tianyu-00/shipdok-test-app';
let withApp = () => ({});
const body = (over = {}) => ({ name: 'My App', repo: REPO, branch: 'main', container_port: 3000, host_port: 9100, ...withApp(), ...over });

beforeEach(async () => {
  await resetDb();
  queue = { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) };
  github = {
    findInstallationForRepo: jest.fn(async () => 777),
    listAllRepos: jest.fn(async () => [{ fullName: REPO, private: true, installationId: 777 }]),
  };
  ghId = (await saveGithubApp(testPool, KEY, { appId: '4242', name: 'Mine', privateKeyPem: PEM, webhookSecret: 'a-webhook-secret-0123456789', source: 'manual' })).id;
  withApp = () => ({ github_app_id: ghId });
  app = await makeApp({ queue, github });
  agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
});
afterAll(closeDb);

describe('creating an app with the GitHub App configured', () => {
  test('stores the installation when the app is installed on the repository', async () => {
    const res = await agent.post('/api/apps').send(body());
    expect(res.status).toBe(201);
    expect(res.body.warning).toBeUndefined();
    expect(Number(res.body.github_installation_id)).toBe(777);
    expect(github.findInstallationForRepo).toHaveBeenCalledWith(REPO);
  });

  test('warns, but still creates the app, when it is not installed', async () => {
    github.findInstallationForRepo.mockResolvedValue(null);
    const res = await agent.post('/api/apps').send(body());
    expect(res.status).toBe(201);
    expect(res.body.warning).toMatch(/not installed/i);
    expect(res.body.github_installation_id).toBeNull();
  });

  test('a GitHub outage never blocks creating an app', async () => {
    github.findInstallationForRepo.mockRejectedValue(new Error('github down'));
    const res = await agent.post('/api/apps').send(body());
    expect(res.status).toBe(201);
    expect(res.body.warning).toMatch(/could not check/i);
  });

  test('with no GitHub app chosen there is no warning and no lookup', async () => {
    const res = await agent.post('/api/apps').send(body({ name: 'Other', host_port: 9101, github_app_id: null }));
    expect(res.status).toBe(201);
    expect(res.body.warning).toBeUndefined();
    expect(res.body.github_app_id).toBeNull();
    expect(github.findInstallationForRepo).not.toHaveBeenCalled();
  });

  test('the chosen GitHub app is stored on the project', async () => {
    const res = await agent.post('/api/apps').send(body());
    expect(res.body.github_app_id).toBe(ghId);
  });

  test('a GitHub app that does not exist is refused, and nothing is created', async () => {
    const res = await agent.post('/api/apps').send(body({ github_app_id: '99999999-9999-4999-8999-999999999999' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('github_app_not_found');
    expect((await testPool.query('SELECT count(*)::int AS n FROM apps')).rows[0].n).toBe(0);
  });

  test('something that is not an id is refused', async () => {
    expect((await agent.post('/api/apps').send(body({ github_app_id: 'mine' }))).status).toBe(400);
  });

  test('a GitHub app whose credentials cannot be read gives a warning, not a failure', async () => {
    const down = request.agent(await makeApp({ queue, github: null }));
    await down.post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    const res = await down.post('/api/apps').send(body({ name: 'Third', host_port: 9102 }));
    expect(res.status).toBe(201);
    expect(res.body.warning).toMatch(/could not check/i);
    expect(res.body.github_installation_id).toBeNull();
  });
});

describe('changing the GitHub app of a project', () => {
  const other = async () => (await saveGithubApp(testPool, KEY, { appId: '5252', name: 'Other', privateKeyPem: PEM, webhookSecret: 'another-webhook-secret-123', source: 'manual' })).id;
  const put = (id, b) => agent.put(`/api/apps/${id}`).send(b);

  test('a different app: the installation is looked up again with the new app, and remembered', async () => {
    const created = (await agent.post('/api/apps').send(body())).body;
    const second = await other();
    github.findInstallationForRepo.mockClear();
    github.findInstallationForRepo.mockResolvedValue(888);
    const res = await put(created.id, { github_app_id: second });
    expect(res.status).toBe(200);
    expect(res.body.github_app_id).toBe(second);
    expect(Number(res.body.github_installation_id)).toBe(888);
    expect(github.findInstallationForRepo).toHaveBeenCalledWith(REPO);
    expect(res.body.warning).toBeUndefined();
  });

  test('a different app that is not installed on the repository: a warning, and the old installation is forgotten', async () => {
    const created = (await agent.post('/api/apps').send(body())).body;
    github.findInstallationForRepo.mockResolvedValue(null);
    const res = await put(created.id, { github_app_id: await other() });
    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/not installed/i);
    expect(res.body.github_installation_id).toBeNull();
  });

  test('none: the project has no GitHub app and no installation, without asking GitHub', async () => {
    const created = (await agent.post('/api/apps').send(body())).body;
    github.findInstallationForRepo.mockClear();
    const res = await put(created.id, { github_app_id: null });
    expect(res.body.github_app_id).toBeNull();
    expect(res.body.github_installation_id).toBeNull();
    expect(github.findInstallationForRepo).not.toHaveBeenCalled();
  });

  test('the same app again changes nothing and does not ask GitHub', async () => {
    const created = (await agent.post('/api/apps').send(body())).body;
    github.findInstallationForRepo.mockClear();
    const res = await put(created.id, { github_app_id: ghId });
    expect(res.status).toBe(200);
    expect(Number(res.body.github_installation_id)).toBe(777);
    expect(github.findInstallationForRepo).not.toHaveBeenCalled();
  });

  test('another setting alone does not touch the GitHub app or the installation', async () => {
    const created = (await agent.post('/api/apps').send(body())).body;
    const res = await put(created.id, { name: 'Renamed' });
    expect(res.body.github_app_id).toBe(ghId);
    expect(Number(res.body.github_installation_id)).toBe(777);
  });

  test('an app that does not exist is refused and nothing changes', async () => {
    const created = (await agent.post('/api/apps').send(body())).body;
    const res = await put(created.id, { github_app_id: '99999999-9999-4999-8999-999999999999' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('github_app_not_found');
    expect((await agent.get(`/api/apps/${created.id}`)).body.github_app_id).toBe(ghId);
  });

  test('it is not a pending change: it is read when a deployment starts, not baked into one', async () => {
    const created = (await agent.post('/api/apps').send(body())).body;
    const res = await put(created.id, { github_app_id: await other() });
    expect(res.body.settings_pending ?? []).not.toContain('github_app_id');
  });
});

describe('deploy jobs carry what the worker needs for GitHub access', () => {
  test('repoFullName, installationId and the GitHub app are in the job data', async () => {
    const created = (await agent.post('/api/apps').send(body())).body;
    const res = await agent.post(`/api/apps/${created.id}/deployments`).send({});
    expect(res.status).toBeLessThan(300);
    const [, data] = queue.add.mock.calls.at(-1);
    expect(data.repoFullName).toBe(REPO);
    expect(data.installationId).toBe(777);
    expect(data.githubAppId).toBe(ghId);
  });

  test('a project with no GitHub app has neither in the job data', async () => {
    const created = (await agent.post('/api/apps').send(body({ github_app_id: null }))).body;
    await agent.post(`/api/apps/${created.id}/deployments`).send({});
    const data = queue.add.mock.calls.at(-1)[1];
    expect(data.githubAppId).toBeUndefined();
    expect(data.installationId).toBeUndefined();
  });

  test('installationId is absent when unknown', async () => {
    github.findInstallationForRepo.mockResolvedValue(null);
    const created = (await agent.post('/api/apps').send(body())).body;
    await agent.post(`/api/apps/${created.id}/deployments`).send({});
    expect(queue.add.mock.calls.at(-1)[1].installationId).toBeUndefined();
  });
});

describe('GET /api/github/apps/:id/repos', () => {
  const url = () => `/api/github/apps/${ghId}/repos`;
  test('requires login', async () => {
    expect((await request(app).get(url())).status).toBe(401);
  });
  test('lists repositories', async () => {
    const res = await agent.get(url());
    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual([{ fullName: REPO, private: true, installationId: 777 }]);
  });
  test('asks the chosen app\'s client', async () => {
    await agent.get(url());
    expect(github.listAllRepos).toHaveBeenCalledTimes(1);
  });
  test('404 for an app that is not connected', async () => {
    const plain = request.agent(await makeApp({ queue, github: null }));
    await plain.post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    const missing = await plain.get('/api/github/apps/99999999-9999-4999-8999-999999999999/repos');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('github_app_not_found');
  });
  test('409 when the app exists but its credentials cannot be used', async () => {
    const plain = request.agent(await makeApp({ queue, github: null }));
    await plain.post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    const res = await plain.get(url());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('cannot_decrypt');
  });
  test('404 for something that is not an id', async () => {
    expect((await agent.get('/api/github/apps/mine/repos')).status).toBe(404);
  });
  test('GitHub failure is a generic 502 with no internals', async () => {
    github.listAllRepos.mockRejectedValue(new Error('secret-detail ghs_xxx'));
    const res = await agent.get(url());
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/secret-detail|ghs_/);
  });
});
