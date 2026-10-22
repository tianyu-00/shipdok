// GET /api/version and the pieces under it: reading VERSION, comparing numbers, finding the newest published tag, and the keeping of answers.
import request from 'supertest';
import { jest } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, newestVersion, readVersion, createVersionCheck, IMAGE_REPOSITORY } from '../src/version.js';
import { makeApp, resetDb, closeDb, PASSWORD } from './helpers.js';

const TAGS = ['latest', '0.1.0', 'sha-d657b4b', '0.1.9', '0.1.10', '0.1.14', 'sha-5ad433f', '0.2.0-rc1', 'v0.9.9'];

// A fake registry: the token request, then the tag list.
function registry({ tags = TAGS, fail = null } = {}) {
  return jest.fn(async (url, init = {}) => {
    if (fail) throw new Error(fail);
    const u = String(url);
    if (u.startsWith('https://ghcr.io/token')) return { ok: true, status: 200, json: async () => ({ token: 'anon-token' }) };
    if (u.startsWith(`https://ghcr.io/v2/${IMAGE_REPOSITORY}/tags/list`)) {
      if (init.headers?.authorization !== 'Bearer anon-token') return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ name: IMAGE_REPOSITORY, tags }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('comparing versions', () => {
  test('numbers, not text: 0.1.10 is newer than 0.1.9', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.9', '0.1.10')).toBeLessThan(0);
    expect(compareVersions('0.2.0', '0.1.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.1.14', '0.1.14')).toBe(0);
  });

  test('the newest of the tags ignores latest, sha-, pre-releases and anything that is not x.y.z', () => {
    expect(newestVersion(TAGS)).toBe('0.1.14');
    expect(newestVersion(['latest', 'sha-abc'])).toBeNull();
    expect(newestVersion([])).toBeNull();
    expect(newestVersion(null)).toBeNull();
    expect(newestVersion(['1.2', '1.2.3.4', '01.2.3x', 7, null, '0.0.1'])).toBe('0.0.1');
  });
});

describe('reading the VERSION file', () => {
  const file = (text) => { const f = join(mkdtempSync(join(tmpdir(), 'ver-')), 'VERSION'); writeFileSync(f, text); return f; };
  test('a number, with the newline after it', () => expect(readVersion(file('0.1.14\n'))).toBe('0.1.14'));
  test('anything else, or no file, is unknown', () => {
    expect(readVersion(file('hello'))).toBeNull();
    expect(readVersion(file(''))).toBeNull();
    expect(readVersion(join(tmpdir(), 'no-such-dir-for-shipdok', 'VERSION'))).toBeNull();
  });
  test('the real file of this checkout is found', () => expect(readVersion()).toMatch(/^\d+\.\d+\.\d+$/));
});

describe('what the check says', () => {
  test('a newer published version is an update', async () => {
    const check = createVersionCheck({ current: '0.1.13', fetch: registry() });
    expect(await check.status()).toMatchObject({ current: '0.1.13', latest: '0.1.14', updateAvailable: true, error: null });
  });

  test('the same version, or a newer one than anything published, is not', async () => {
    expect((await createVersionCheck({ current: '0.1.14', fetch: registry() }).status()).updateAvailable).toBe(false);
    expect((await createVersionCheck({ current: '0.3.0', fetch: registry() }).status()).updateAvailable).toBe(false);
  });

  test('an unknown own version never claims an update', async () => {
    expect(await createVersionCheck({ current: null, fetch: registry() }).status()).toMatchObject({ current: null, latest: '0.1.14', updateAvailable: false });
  });

  test('an unreachable registry is reported as such, with no update claimed', async () => {
    expect(await createVersionCheck({ current: '0.1.0', fetch: registry({ fail: 'getaddrinfo ENOTFOUND' }) }).status())
      .toMatchObject({ latest: null, updateAvailable: false, error: 'unreachable' });
  });

  test('a registry with no releases in it is its own answer', async () => {
    expect(await createVersionCheck({ current: '0.1.0', fetch: registry({ tags: ['latest'] }) }).status())
      .toMatchObject({ latest: null, updateAvailable: false, error: 'no_versions' });
  });

  test('a refusal (not a thrown error) counts as unreachable too', async () => {
    const fetch = jest.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    expect((await createVersionCheck({ current: '0.1.0', fetch }).status()).error).toBe('unreachable');
  });

  test('only the public image\'s registry is asked, with no credentials of ours', async () => {
    const fetch = registry();
    await createVersionCheck({ current: '0.1.0', fetch }).status();
    const urls = fetch.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.startsWith('https://ghcr.io/'))).toBe(true);
    expect(fetch.mock.calls[0][1].headers.authorization).toBeUndefined();
  });
});

describe('how long an answer is kept', () => {
  const HOUR = 3600_000;
  let t;
  const now = () => t;
  beforeEach(() => { t = 1_000_000; });

  test('an hour for a good answer: the registry is asked once for many page loads', async () => {
    const fetch = registry();
    const check = createVersionCheck({ current: '0.1.0', fetch, now });
    await check.status();
    const asked = fetch.mock.calls.length;
    t += HOUR - 1000;
    await check.status();
    expect(fetch.mock.calls.length).toBe(asked);
    t += 2000;
    await check.status();
    expect(fetch.mock.calls.length).toBeGreaterThan(asked);
  });

  test('five minutes for a failure, so a registry that is down is not hammered but is tried again soon', async () => {
    const fetch = registry({ fail: 'down' });
    const check = createVersionCheck({ current: '0.1.0', fetch, now });
    await check.status();
    const asked = fetch.mock.calls.length;
    t += 4 * 60_000;
    await check.status();
    expect(fetch.mock.calls.length).toBe(asked);
    t += 2 * 60_000;
    await check.status();
    expect(fetch.mock.calls.length).toBeGreaterThan(asked);
  });

  test('"fresh" looks again, but not more than about twice a minute', async () => {
    const fetch = registry();
    const check = createVersionCheck({ current: '0.1.0', fetch, now });
    await check.status();
    const asked = fetch.mock.calls.length;
    t += 10_000;
    await check.status({ fresh: true });
    expect(fetch.mock.calls.length).toBe(asked);
    t += 25_000;
    await check.status({ fresh: true });
    expect(fetch.mock.calls.length).toBeGreaterThan(asked);
  });

  test('the answer says when the registry was asked', async () => {
    const check = createVersionCheck({ current: '0.1.0', fetch: registry(), now });
    expect((await check.status()).checkedAt).toBe(new Date(1_000_000).toISOString());
  });
});

describe('GET /api/version', () => {
  let agent;
  beforeEach(async () => {
    await resetDb();
    agent = request.agent(await makeApp({ queue: { add: jest.fn(), remove: jest.fn() }, versionCheck: createVersionCheck({ current: '0.1.13', fetch: registry() }) }));
    await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  });
  afterAll(closeDb);

  test('needs a session', async () => {
    const anon = request(await makeApp({ queue: {}, versionCheck: createVersionCheck({ current: '0.1.13', fetch: registry() }) }));
    expect((await anon.get('/api/version')).status).toBe(401);
  });

  test('answers with the running version, the newest and whether to update', async () => {
    const res = await agent.get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ current: '0.1.13', latest: '0.1.14', updateAvailable: true, error: null });
    expect(typeof res.body.checkedAt).toBe('string');
  });

  test('a failed look is still a 200 that says so', async () => {
    const a = request.agent(await makeApp({ queue: {}, versionCheck: createVersionCheck({ current: '0.1.13', fetch: registry({ fail: 'down' }) }) }));
    await a.post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    const res = await a.get('/api/version');
    expect([res.status, res.body.error, res.body.updateAvailable]).toEqual([200, 'unreachable', false]);
  });

  test('?fresh=1 is passed on, anything else is not', async () => {
    const status = jest.fn(async () => ({ current: '1.0.0', latest: '1.0.0', updateAvailable: false, checkedAt: 'x', error: null }));
    const a = request.agent(await makeApp({ queue: {}, versionCheck: { status } }));
    await a.post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    await a.get('/api/version?fresh=1');
    await a.get('/api/version?fresh=true');
    await a.get('/api/version');
    expect(status.mock.calls.map((c) => c[0].fresh)).toEqual([true, false, false]);
  });
});
