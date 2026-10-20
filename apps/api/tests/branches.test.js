// GET /api/github/branches: the branches of a repository, for the branch pickers.
import request from 'supertest';
import { jest } from '@jest/globals';
import { GithubError } from '@shipdok/shared';
import { makeApp, resetDb, closeDb, PASSWORD } from './helpers.js';

const REPO = 'tianyu-00/shipdok-test-app';
const LIST = { defaultBranch: 'main', branches: ['main', 'develop', 'release'], truncated: false };
let agent;
let github;
let queue;

// The first call creates the administrator; later ones (another app instance on the same database) just sign in.
let accountMade = false;
const login = async (extra = {}) => {
  const a = request.agent(await makeApp({ queue, ...extra }));
  await a.post(accountMade ? '/api/auth/login' : '/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  accountMade = true;
  return a;
};
const get = (repo = REPO, a = agent) => a.get('/api/github/branches').query({ repo });
const getWithout = () => agent.get('/api/github/branches');

beforeEach(async () => {
  await resetDb();
  accountMade = false;
  queue = { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) };
  github = { listBranches: jest.fn(async () => LIST), findInstallationForRepo: jest.fn(async () => 777), listAllRepos: jest.fn(async () => []) };
  agent = await login({ github });
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeDb);

describe('who may ask, and what', () => {
  test('needs a session', async () => {
    const anon = request(await makeApp({ queue, github }));
    expect((await anon.get('/api/github/branches').query({ repo: REPO })).status).toBe(401);
    expect(github.listBranches).not.toHaveBeenCalled();
  });

  test('returns the default branch, the branches and whether the list was cut short', async () => {
    const res = await get();
    expect([res.status, res.body]).toEqual([200, LIST]);
    expect(github.listBranches).toHaveBeenCalledWith(REPO);
  });

  test.each([[''], ['x'], ['a/b/c'], ['../x'], ['o/..'], ['o/r?x=1'], ['o/r#frag'], ['o /r'], ['o/r\n']])('the repository %j is refused before GitHub is asked', async (repo) => {
    const res = await get(repo);
    expect([res.status, res.body.code]).toEqual([400, 'bad_repo']);
    expect(github.listBranches).not.toHaveBeenCalled();
  });

  test('no repository at all is refused', async () => {
    const res = await getWithout();
    expect([res.status, res.body.code]).toEqual([400, 'bad_repo']);
    expect(github.listBranches).not.toHaveBeenCalled();
  });

  test('the repository given twice (an array) is refused too', async () => {
    const res = await agent.get('/api/github/branches?repo=a/b&repo=c/d');
    expect(res.status).toBe(400);
    expect(github.listBranches).not.toHaveBeenCalled();
  });
});

describe('with no GitHub App connected', () => {
  const publicGithub = (handler) => {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url: String(url), headers: init.headers });
      const r = handler(new URL(url));
      return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
    };
    fn.calls = calls;
    return fn;
  };
  const okHandler = (url) => (url.pathname.endsWith('/branches') ? { json: [{ name: 'dev' }, { name: 'main' }] } : { json: { default_branch: 'main' } });

  test('public repositories still list, anonymously (no Authorization header)', async () => {
    const githubFetch = publicGithub(okHandler);
    const a = await login({ github: null, githubFetch });
    const res = await get(REPO, a);
    expect([res.status, res.body]).toEqual([200, { defaultBranch: 'main', branches: ['main', 'dev'], truncated: false }]);
    expect(githubFetch.calls.length).toBe(2);
    for (const c of githubFetch.calls) expect(c.headers.Authorization).toBeUndefined();
  });

  test('a repository that is not public is a 404 with a plain explanation', async () => {
    const githubFetch = publicGithub(() => ({ status: 404 }));
    const a = await login({ github: null, githubFetch });
    const res = await get(REPO, a);
    expect([res.status, res.body.code]).toEqual([404, 'repo_not_found']);
    expect(res.body.error).toMatch(/private repository needs the app/);
  });
});

describe('when GitHub says no', () => {
  test('a repository nobody can see (404) is repo_not_found, so the form can say what to do', async () => {
    github.listBranches.mockRejectedValue(new GithubError('GitHub API request failed (HTTP 404)', 404));
    const res = await get();
    expect([res.status, res.body.code]).toEqual([404, 'repo_not_found']);
  });

  test.each([[403], [429]])('a rate limit (%i) is a 502 rate_limited', async (status) => {
    github.listBranches.mockRejectedValue(new GithubError(`GitHub API request failed (HTTP ${status})`, status));
    const res = await get();
    expect([res.status, res.body.code]).toEqual([502, 'rate_limited']);
  });

  test('anything else is a generic 502 with no internals', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    github.listBranches.mockRejectedValue(new Error('secret-detail ghs_xxx at /app/internal.js'));
    const res = await get();
    expect([res.status, res.body.code]).toEqual([502, 'github_unreachable']);
    expect(JSON.stringify(res.body)).not.toMatch(/secret-detail|ghs_|internal\.js/);
  });
});

describe('the one-minute memory', () => {
  test('asking again soon does not ask GitHub again', async () => {
    await get();
    await get();
    expect(github.listBranches).toHaveBeenCalledTimes(1);
  });

  test('another repository, or the same one after a minute, is asked for', async () => {
    const real = Date.now();
    let offset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => real + offset);
    await get();
    await get('someone/else');
    expect(github.listBranches).toHaveBeenCalledTimes(2);
    offset = 61_000;
    await get();
    expect(github.listBranches).toHaveBeenCalledTimes(3);
  });

  test('a failure is not remembered: the next ask tries again', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    github.listBranches.mockRejectedValueOnce(new GithubError('GitHub API request failed (HTTP 500)', 500));
    expect((await get()).status).toBe(502);
    expect((await get()).status).toBe(200);
    expect(github.listBranches).toHaveBeenCalledTimes(2);
  });

  test('upper and lower case of the same repository share an answer (GitHub treats them as one)', async () => {
    await get('TianYu-00/Shipdok-Test-App');
    await get(REPO);
    expect(github.listBranches).toHaveBeenCalledTimes(1);
  });
});
