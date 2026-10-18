import request from 'supertest';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let queue, agent, github, app;
const REPO = 'tianyu-00/shipdok-test-app';
const body = (over = {}) => ({ name: 'My App', repo: REPO, branch: 'main', container_port: 3000, host_port: 9100, ...over });

beforeEach(async () => {
  await resetDb();
  queue = { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) };
  github = {
    findInstallationForRepo: jest.fn(async () => 777),
    listAllRepos: jest.fn(async () => [{ fullName: REPO, private: true, installationId: 777 }]),
  };
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

  test('without a GitHub App configured there is no warning and no lookup', async () => {
    const plain = request.agent(await makeApp({ queue, github: null }));
    await plain.post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    const res = await plain.post('/api/apps').send(body({ name: 'Other', host_port: 9101 }));
    expect(res.status).toBe(201);
    expect(res.body.warning).toBeUndefined();
    expect(github.findInstallationForRepo).not.toHaveBeenCalled();
  });
});

describe('deploy jobs carry what the worker needs for GitHub access', () => {
  test('repoFullName and installationId are in the job data', async () => {
    const created = (await agent.post('/api/apps').send(body())).body;
    const res = await agent.post(`/api/apps/${created.id}/deployments`).send({});
    expect(res.status).toBeLessThan(300);
    const [, data] = queue.add.mock.calls.at(-1);
    expect(data.repoFullName).toBe(REPO);
    expect(data.installationId).toBe(777);
  });

  test('installationId is absent when unknown', async () => {
    github.findInstallationForRepo.mockResolvedValue(null);
    const created = (await agent.post('/api/apps').send(body())).body;
    await agent.post(`/api/apps/${created.id}/deployments`).send({});
    expect(queue.add.mock.calls.at(-1)[1].installationId).toBeUndefined();
  });
});

describe('GET /api/github/repos', () => {
  test('requires login', async () => {
    expect((await request(app).get('/api/github/repos')).status).toBe(401);
  });
  test('lists repositories', async () => {
    const res = await agent.get('/api/github/repos');
    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual([{ fullName: REPO, private: true, installationId: 777 }]);
  });
  test('501 when the GitHub App is not configured', async () => {
    const plain = request.agent(await makeApp({ queue, github: null }));
    await plain.post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    expect((await plain.get('/api/github/repos')).status).toBe(501);
  });
  test('GitHub failure is a generic 502 with no internals', async () => {
    github.listAllRepos.mockRejectedValue(new Error('secret-detail ghs_xxx'));
    const res = await agent.get('/api/github/repos');
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/secret-detail|ghs_/);
  });
});
