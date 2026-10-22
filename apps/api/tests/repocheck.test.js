// GET /api/github/repo-check: can Shipdok see this repository? The first step of creating an app. Nothing inside the repository is read.
import request from 'supertest';
import { jest } from '@jest/globals';
import { GithubError } from '@shipdok/shared';
import { makeApp, resetDb, closeDb, PASSWORD } from './helpers.js';

const REPO = 'tianyu-00/shipdok-test-app';
const APP = '11111111-1111-4111-8111-111111111111'; // the test client answers for any GitHub app id
const OTHER_APP = '22222222-2222-4222-8222-222222222222';
let github;
let queue;
let accountMade = false;
const login = async (extra = {}) => {
  const a = request.agent(await makeApp({ queue, ...extra }));
  await a.post(accountMade ? '/api/auth/login' : '/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  accountMade = true;
  return a;
};
const INFO = { fullName: REPO, private: true, defaultBranch: 'main', via: 'app' };
const check = (a, repo = REPO, app = APP, extra = {}) => a.get('/api/github/repo-check').query({ repo, ...(app ? { app } : {}), ...extra });
let agent;

beforeEach(async () => {
  await resetDb();
  accountMade = false;
  queue = { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) };
  github = { inspectRepo: jest.fn(async () => INFO), findInstallationForRepo: jest.fn(async () => 1), listAllRepos: jest.fn(async () => []) };
  agent = await login({ github });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeDb);

describe('who may ask, and what', () => {
  test('needs a session', async () => {
    const anon = request(await makeApp({ queue, github }));
    expect((await anon.get('/api/github/repo-check').query({ repo: REPO })).status).toBe(401);
    expect(github.inspectRepo).not.toHaveBeenCalled();
  });

  test.each([[''], ['x'], ['a/b/c'], ['../x'], ['o/..'], ['o/r?x=1'], ['o/r\n']])('the repository %j is refused before GitHub is asked', async (repo) => {
    const res = await check(agent, repo);
    expect([res.status, res.body.code]).toEqual([400, 'bad_repo']);
    expect(github.inspectRepo).not.toHaveBeenCalled();
  });

  test('no repository, or two, is refused', async () => {
    expect((await agent.get('/api/github/repo-check')).status).toBe(400);
    expect((await agent.get('/api/github/repo-check?repo=a/b&repo=c/d')).status).toBe(400);
  });

  test('a GitHub app that is not connected is a 404 about the app, and GitHub is not asked', async () => {
    const a = await login({ github: null });
    const res = await check(a, REPO, OTHER_APP);
    expect([res.status, res.body.code]).toEqual([404, 'github_app_not_found']);
  });
});

describe('a repository that can be seen', () => {
  test('says what it is, and nothing about what is inside it', async () => {
    const res = await check(agent);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accessible: true, fullName: REPO, private: true, defaultBranch: 'main', via: 'app', appChosen: true });
    expect(github.inspectRepo).toHaveBeenCalledWith(REPO);
  });

  test('with no GitHub app it goes anonymously, through the public API, in ONE request, and says so', async () => {
    const calls = [];
    const githubFetch = async (url, init) => {
      calls.push({ url: String(url), headers: init.headers });
      return new Response(JSON.stringify({ full_name: REPO, private: false, default_branch: 'trunk' }), { status: 200 });
    };
    const a = await login({ github, githubFetch });
    const res = await check(a, REPO, null);
    expect(res.body).toEqual({ accessible: true, fullName: REPO, private: false, defaultBranch: 'trunk', via: 'anonymous', appChosen: false });
    expect(github.inspectRepo).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.github.com/repos/${REPO}`);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });
});

describe('a repository that cannot be seen is an ordinary answer, not an error', () => {
  const fails = (err) => github.inspectRepo.mockRejectedValue(err);

  test('404: not_found, and whether an app was asked', async () => {
    fails(new GithubError('GitHub API request failed (HTTP 404)', 404));
    expect((await check(agent)).body).toEqual({ accessible: false, reason: 'not_found', appChosen: true });
    const a = await login({ github: null, githubFetch: async () => new Response('{}', { status: 404 }) });
    const res = await check(a, REPO, null);
    expect([res.status, res.body]).toEqual([200, { accessible: false, reason: 'not_found', appChosen: false }]);
  });

  test.each([403, 429])('%d: rate_limited', async (status) => {
    fails(new GithubError(`HTTP ${status}`, status));
    const res = await check(agent);
    expect([res.status, res.body.reason]).toEqual([200, 'rate_limited']);
  });

  test('anything else: unreachable (and logged)', async () => {
    fails(new GithubError('Could not reach GitHub', undefined));
    expect((await check(agent)).body).toMatchObject({ accessible: false, reason: 'unreachable' });
    fails(new Error('boom'));
    expect((await check(agent)).body).toMatchObject({ accessible: false, reason: 'unreachable' });
    expect(console.error).toHaveBeenCalled();
  });
});

describe('what is kept', () => {
  test('a good answer is kept briefly, per app and repository, so choosing and choosing again does not ask GitHub twice', async () => {
    await check(agent);
    await check(agent);
    expect(github.inspectRepo).toHaveBeenCalledTimes(1);
    await check(agent, 'tianyu-00/other');
    expect(github.inspectRepo).toHaveBeenCalledTimes(2);
  });

  test('the name is not case-sensitive for the keeping', async () => {
    await check(agent, REPO.toUpperCase());
    await check(agent, REPO);
    expect(github.inspectRepo).toHaveBeenCalledTimes(1);
  });

  test('fresh=1 asks again (the check again after installing the app)', async () => {
    await check(agent);
    await check(agent, REPO, APP, { fresh: '1' });
    expect(github.inspectRepo).toHaveBeenCalledTimes(2);
  });

  test('a failure is never kept: the next try asks GitHub again', async () => {
    github.inspectRepo.mockRejectedValueOnce(new GithubError('HTTP 404', 404));
    expect((await check(agent)).body.accessible).toBe(false);
    expect((await check(agent)).body.accessible).toBe(true);
    expect(github.inspectRepo).toHaveBeenCalledTimes(2);
  });

  test('what one GitHub app can see is not given as the answer for another (each app has its own installations)', async () => {
    await check(agent, REPO, APP);
    await check(agent, REPO, OTHER_APP);
    expect(github.inspectRepo).toHaveBeenCalledTimes(2);
    await check(agent, REPO, OTHER_APP);
    expect(github.inspectRepo).toHaveBeenCalledTimes(2); // (and each is kept)
  });

  test('the answers are kept apart for different GitHub apps and for no app', async () => {
    const a = await login({ github, githubFetch: async () => new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 }) });
    await check(a, REPO, APP);
    await check(a, REPO, null);
    await check(a, REPO, APP);
    expect(github.inspectRepo).toHaveBeenCalledTimes(1); // (the anonymous one went to the public API, not to the app)
  });
});
