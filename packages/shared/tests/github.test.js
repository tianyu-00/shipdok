import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify, createPublicKey } from 'node:crypto';
import {
  GithubError, parsePrivateKeyPem, signAppJwt, createGithubClient, exchangeManifestCode, gitAuthEnv, REPO_FULL_NAME_RE,
} from '../src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const APP_ID = '123456';
const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

// ---- a fake GitHub ----
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = await handler(call, calls.length);
    return new Response(r.rawBody ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}
const tokenReply = (token, minutes = 60) => ({ status: 201, json: { token, expires_at: new Date(T0 + minutes * 60_000).toISOString() } });
const clock = () => { const c = { t: T0, now: () => c.t, advance: (ms) => { c.t += ms; } }; return c; };
const makeClient = (fetch, c = clock(), extra = {}) => createGithubClient({ appId: APP_ID, privateKey, fetch, now: c.now, ...extra });
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());

describe('signAppJwt', () => {
  const jwt = signAppJwt({ appId: APP_ID, privateKey, now: T0 });
  const [h, p, s] = jwt.split('.');

  test('is a three-part RS256 token', () => {
    assert.equal(jwt.split('.').length, 3);
    assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT' });
  });

  test('claims: issued by the app, backdated 60s for clock drift, expiring within GitHub\'s 10 minute limit', () => {
    const claims = decode(p);
    assert.equal(claims.iss, APP_ID);
    assert.equal(claims.iat, T0 / 1000 - 60);
    assert.equal(claims.exp, T0 / 1000 + 540);
    assert.ok(claims.exp - T0 / 1000 <= 600, 'must be at most 10 minutes from now');
  });

  test('the signature verifies with the matching public key, and only that one', () => {
    const verify = (key) => createVerify('RSA-SHA256').update(`${h}.${p}`).verify(key, Buffer.from(s, 'base64url'));
    assert.equal(verify(publicKey), true);
    assert.equal(verify(createPublicKey(otherKey)), false);
  });

  test('changing the payload invalidates the signature', () => {
    const forged = Buffer.from(JSON.stringify({ ...decode(p), iss: '999' })).toString('base64url');
    assert.equal(createVerify('RSA-SHA256').update(`${h}.${forged}`).verify(publicKey, Buffer.from(s, 'base64url')), false);
  });
});

describe('parsePrivateKeyPem', () => {
  test('reads the PKCS#8 text', () => {
    assert.equal(parsePrivateKeyPem(pem).asymmetricKeyType, 'rsa');
  });

  test('reads the PKCS#1 text GitHub hands out ("BEGIN RSA PRIVATE KEY")', () => {
    const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' });
    assert.match(pkcs1, /BEGIN RSA PRIVATE KEY/);
    assert.equal(parsePrivateKeyPem(pkcs1).asymmetricKeyType, 'rsa');
  });

  test('tolerates spaces around it and Windows line endings', () => {
    assert.equal(parsePrivateKeyPem(`\n  ${pem}  \n`).asymmetricKeyType, 'rsa');
    assert.equal(parsePrivateKeyPem(pem.replace(/\n/g, '\r\n')).asymmetricKeyType, 'rsa');
  });

  test('the key it returns signs what the original signs', () => {
    const a = signAppJwt({ appId: APP_ID, privateKey: parsePrivateKeyPem(pem), now: T0 });
    const b = signAppJwt({ appId: APP_ID, privateKey, now: T0 });
    assert.equal(a, b);
  });

  for (const [label, input, message] of [
    ['nothing', '', /empty/],
    ['only spaces', '   \n ', /empty/],
    ['not text', undefined, /empty/],
    ['a number', 12345, /empty/],
    ['garbage', 'not a pem', /not a valid PEM/],
    ['a truncated key', pem.slice(0, 80), /not a valid PEM/],
    ['a public key', publicKey.export({ type: 'spki', format: 'pem' }), /not a valid PEM/],
  ]) {
    test(`rejects ${label} with a clear message`, () => assert.throws(() => parsePrivateKeyPem(input), message));
  }

  test('rejects a key that is not RSA', () => {
    const { privateKey: ed } = generateKeyPairSync('ed25519');
    assert.throws(() => parsePrivateKeyPem(ed.export({ type: 'pkcs8', format: 'pem' })), /must be an RSA key/);
  });

  test('error messages never contain key material', () => {
    const body = pem.split('\n')[1];
    for (const input of [pem.slice(0, 60) + ' broken', publicKey.export({ type: 'spki', format: 'pem' })]) {
      try { parsePrivateKeyPem(input); } catch (err) { assert.ok(!err.message.includes(body)); }
    }
  });
});

describe('installation tokens', () => {
  test('exchanges the app JWT for a token, sending the right request', async () => {
    const fetch = fakeFetch(() => tokenReply('ghs_one'));
    const token = await makeClient(fetch).getInstallationToken(42);
    assert.equal(token, 'ghs_one');
    const [call] = fetch.calls;
    assert.equal(call.url, 'https://api.github.com/app/installations/42/access_tokens');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.Accept, 'application/vnd.github+json');
    assert.match(call.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const [h, p, s] = call.headers.Authorization.slice(7).split('.');
    assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')), 'authorised with a validly signed app JWT');
  });

  test('a clone token is scoped to one repository with read-only contents access', async () => {
    const fetch = fakeFetch(() => tokenReply('ghs_scoped'));
    await makeClient(fetch).getInstallationToken(42, { repo: 'tianyu-00/shipdok-test-app', permissions: { contents: 'read' } });
    assert.deepEqual(fetch.calls[0].body, { repositories: ['shipdok-test-app'], permissions: { contents: 'read' } });
  });

  test('is cached, and refreshed once it is within 5 minutes of expiring', async () => {
    const c = clock();
    let n = 0;
    const fetch = fakeFetch(() => tokenReply(`ghs_${++n}`, 60));
    const client = makeClient(fetch, c);
    assert.equal(await client.getInstallationToken(42), 'ghs_1');
    c.advance(30 * 60_000);
    assert.equal(await client.getInstallationToken(42), 'ghs_1');
    assert.equal(fetch.calls.length, 1, 'served from cache');
    c.advance(26 * 60_000); // 56 minutes in: 4 minutes left, inside the refresh margin
    assert.equal(await client.getInstallationToken(42), 'ghs_2');
    assert.equal(fetch.calls.length, 2);
  });

  test('different installations and different repositories never share a token', async () => {
    let n = 0;
    const fetch = fakeFetch(() => tokenReply(`ghs_${++n}`));
    const client = makeClient(fetch);
    const tokens = [
      await client.getInstallationToken(1),
      await client.getInstallationToken(2),
      await client.getInstallationToken(1, { repo: 'o/a' }),
      await client.getInstallationToken(1, { repo: 'o/b' }),
    ];
    assert.equal(new Set(tokens).size, 4);
  });

  test('concurrent callers share a single request', async () => {
    const fetch = fakeFetch(async () => { await new Promise((r) => setTimeout(r, 20)); return tokenReply('ghs_shared'); });
    const client = makeClient(fetch);
    const results = await Promise.all(Array.from({ length: 8 }, () => client.getInstallationToken(7, { repo: 'o/r' })));
    assert.deepEqual([...new Set(results)], ['ghs_shared']);
    assert.equal(fetch.calls.length, 1);
  });

  test('a failure is not cached: the next call tries again', async () => {
    const fetch = fakeFetch((_, n) => (n === 1 ? { status: 500 } : tokenReply('ghs_ok')));
    const client = makeClient(fetch);
    await assert.rejects(client.getInstallationToken(7), (e) => e instanceof GithubError && e.status === 500);
    assert.equal(await client.getInstallationToken(7), 'ghs_ok');
  });

  test('errors carry only a status: never the response body, the token or the key', async () => {
    const leak = 'ghs_SUPERSECRET_TOKEN_VALUE';
    const fetch = fakeFetch(() => ({ status: 401, rawBody: JSON.stringify({ message: `Bad credentials ${leak}`, token: leak }) }));
    try {
      await makeClient(fetch).getInstallationToken(7);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.message, 'GitHub API request failed (HTTP 401)');
      assert.equal(err.status, 401);
      assert.ok(!err.message.includes(leak) && !String(err.stack).includes(leak));
    }
  });

  test('a network failure becomes a generic error with no status', async () => {
    const client = createGithubClient({ appId: APP_ID, privateKey, fetch: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:443 secret-detail'); } });
    await assert.rejects(client.getInstallationToken(7), (e) => e.message === 'Could not reach GitHub' && e.status === undefined);
  });

  for (const [label, response] of [
    ['a missing token', tokenReply('')],
    ['a missing expiry', { status: 201, json: { token: 'ghs_x' } }],
    ['an unparseable expiry', { status: 201, json: { token: 'ghs_x', expires_at: 'soon' } }],
    ['a body that is not JSON', { status: 201, rawBody: '<html>' }],
  ]) {
    test(`rejects ${label}`, async () => {
      await assert.rejects(makeClient(fakeFetch(() => response)).getInstallationToken(7), GithubError);
    });
  }

  for (const bad of ['abc', -1, 0, 1.5, '1; DROP', null, undefined, '../x']) {
    test(`rejects the installation id ${JSON.stringify(bad)} without calling GitHub`, async () => {
      const fetch = fakeFetch(() => tokenReply('x'));
      await assert.rejects(makeClient(fetch).getInstallationToken(bad), TypeError);
      assert.equal(fetch.calls.length, 0);
    });
  }

  for (const bad of ['a/b/c', 'a b', '../x', './x', 'o/..', 'o/.', '..', '.', 'o/r?x=1', '']) {
    test(`rejects the repository ${JSON.stringify(bad)} without calling GitHub`, async () => {
      const fetch = fakeFetch(() => tokenReply('x'));
      await assert.rejects(makeClient(fetch).getInstallationToken(7, { repo: bad }), TypeError);
      assert.equal(fetch.calls.length, 0);
    });
  }
});

describe('findInstallationForRepo', () => {
  test('returns the installation id', async () => {
    const fetch = fakeFetch(() => ({ json: { id: 98765 } }));
    assert.equal(await makeClient(fetch).findInstallationForRepo('tianyu-00/shipdok-test-app'), 98765);
    assert.equal(fetch.calls[0].url, 'https://api.github.com/repos/tianyu-00/shipdok-test-app/installation');
    assert.match(fetch.calls[0].headers.Authorization, /^Bearer /);
  });

  test('returns null when the app is not installed on that repository', async () => {
    assert.equal(await makeClient(fakeFetch(() => ({ status: 404 }))).findInstallationForRepo('o/r'), null);
  });

  test('other failures are errors, not silently "not installed"', async () => {
    for (const status of [401, 403, 500]) {
      await assert.rejects(makeClient(fakeFetch(() => ({ status }))).findInstallationForRepo('o/r'), (e) => e.status === status);
    }
  });

  for (const bad of ['not-a-repo', 'a/b/c', 'o/r?x=1', '../etc/passwd', '../x', './x', 'o/..', 'o/.', undefined]) {
    test(`rejects ${JSON.stringify(bad)} before any request`, async () => {
      const fetch = fakeFetch(() => ({ json: { id: 1 } }));
      await assert.rejects(makeClient(fetch).findInstallationForRepo(bad), TypeError);
      assert.equal(fetch.calls.length, 0);
    });
  }
});

describe('listing repositories', () => {
  const repo = (n) => ({ full_name: `o/r${n}`, private: n % 2 === 0, default_branch: 'main' });

  test('follows pagination and maps the fields', async () => {
    const fetch = fakeFetch((call) => (call.url.includes('page=2')
      ? { json: { repositories: [repo(3)] } }
      : { json: { repositories: [repo(1), repo(2)] }, headers: { link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"' } }));
    // the first call is the token exchange
    const calls = [];
    const wrapped = async (url, init) => (url.includes('access_tokens') ? new Response(JSON.stringify({ token: 'ghs_t', expires_at: new Date(T0 + 3600_000).toISOString() }), { status: 201 }) : (calls.push(url), fetch(url, init)));
    const repos = await makeClient(wrapped).listInstallationRepos(5);
    assert.deepEqual(repos.map((r) => r.fullName), ['o/r1', 'o/r2', 'o/r3']);
    assert.deepEqual(repos[1], { fullName: 'o/r2', private: true, defaultBranch: 'main' });
    assert.equal(calls.length, 2);
  });

  test('never follows a pagination link that leaves GitHub', async () => {
    const seen = [];
    const fetch = async (url) => {
      if (url.includes('access_tokens')) return new Response(JSON.stringify({ token: 'ghs_t', expires_at: new Date(T0 + 3600_000).toISOString() }), { status: 201 });
      seen.push(url);
      return new Response(JSON.stringify({ repositories: [repo(1)] }), { status: 200, headers: { link: '<https://evil.example/steal?page=2>; rel="next"' } });
    };
    const repos = await makeClient(fetch).listInstallationRepos(5);
    assert.equal(repos.length, 1);
    assert.deepEqual(seen.filter((u) => !u.startsWith('https://api.github.com')), []);
  });

  test('stops after 10 pages even if GitHub keeps offering more', async () => {
    let pages = 0;
    const fetch = async (url) => {
      if (url.includes('access_tokens')) return new Response(JSON.stringify({ token: 'ghs_t', expires_at: new Date(T0 + 3600_000).toISOString() }), { status: 201 });
      pages += 1;
      return new Response(JSON.stringify({ repositories: [repo(pages)] }), { status: 200, headers: { link: '<https://api.github.com/installation/repositories?page=99>; rel="next"' } });
    };
    await makeClient(fetch).listInstallationRepos(5);
    assert.equal(pages, 10);
  });

  test('listAllRepos combines installations and tags each repository with its installation', async () => {
    const fetch = async (url) => {
      if (url.endsWith('/app/installations?per_page=100')) return new Response(JSON.stringify([{ id: 1, account: { login: 'alice' } }, { id: 2, account: { login: 'bob' } }]), { status: 200 });
      if (url.includes('access_tokens')) return new Response(JSON.stringify({ token: `ghs_${url.split('/')[5]}`, expires_at: new Date(T0 + 3600_000).toISOString() }), { status: 201 });
      return new Response(JSON.stringify({ repositories: [repo(1)] }), { status: 200 });
    };
    const all = await makeClient(fetch).listAllRepos();
    assert.deepEqual(all.map((r) => r.installationId), [1, 2]);
  });

  test('getApp reports the app and proves the credentials work', async () => {
    const fetch = fakeFetch(() => ({ json: { id: 1, slug: 'shipdok', name: 'Shipdok', html_url: 'https://github.com/apps/shipdok', owner: { login: 'tianyu-00' }, secret_stuff: 'ignored' } }));
    assert.deepEqual(await makeClient(fetch).getApp(), { id: 1, slug: 'shipdok', name: 'Shipdok', htmlUrl: 'https://github.com/apps/shipdok', ownerLogin: 'tianyu-00' });
  });

  test('getApp copes with an app that reports no owner', async () => {
    const fetch = fakeFetch(() => ({ json: { id: 1, slug: 'shipdok', name: 'Shipdok', html_url: 'https://github.com/apps/shipdok' } }));
    assert.equal((await makeClient(fetch).getApp()).ownerLogin, null);
  });

  test('getWebhookConfig reads the address GitHub sends webhooks to', async () => {
    const fetch = fakeFetch(() => ({ json: { url: 'https://shipdok.example.com/api/webhooks/github', content_type: 'json', secret: '********', insecure_ssl: '0' } }));
    const cfg = await makeClient(fetch).getWebhookConfig();
    assert.deepEqual(cfg, { url: 'https://shipdok.example.com/api/webhooks/github' });
    assert.equal(fetch.calls[0].url, 'https://api.github.com/app/hook/config');
    assert.equal(fetch.calls[0].method, 'GET');
    assert.match(fetch.calls[0].headers.Authorization, /^Bearer /);
  });

  test('getWebhookConfig says there is no address when GitHub has none', async () => {
    const fetch = fakeFetch(() => ({ json: { content_type: 'json' } }));
    assert.deepEqual(await makeClient(fetch).getWebhookConfig(), { url: null });
  });

  test('updateWebhookUrl changes ONLY the address (the secret and content type are not sent)', async () => {
    const fetch = fakeFetch(() => ({ json: { url: 'https://new.example.com/api/webhooks/github' } }));
    await makeClient(fetch).updateWebhookUrl('https://new.example.com/api/webhooks/github');
    const [call] = fetch.calls;
    assert.equal(call.url, 'https://api.github.com/app/hook/config');
    assert.equal(call.method, 'PATCH');
    assert.deepEqual(call.body, { url: 'https://new.example.com/api/webhooks/github' });
    assert.match(call.headers.Authorization, /^Bearer /);
  });

  test('updateWebhookUrl refuses anything that is not an http(s) address, without calling GitHub', async () => {
    const fetch = fakeFetch(() => ({ json: {} }));
    for (const bad of ['', 'javascript:alert(1)', 'ftp://x.example.com', 'not a url', undefined, 12]) {
      await assert.rejects(() => makeClient(fetch).updateWebhookUrl(bad), TypeError);
    }
    assert.equal(fetch.calls.length, 0);
  });

  test('a failure of the webhook calls carries only the status', async () => {
    const fetch = fakeFetch(() => ({ status: 403, json: { message: 'secret internal detail' } }));
    await assert.rejects(() => makeClient(fetch).updateWebhookUrl('https://x.example.com/h'), (e) => e instanceof GithubError && e.status === 403 && !/secret/.test(e.message));
    await assert.rejects(() => makeClient(fetch).getWebhookConfig(), (e) => e.status === 403);
  });
});

describe('exchangeManifestCode', () => {
  const converted = (over = {}) => ({
    id: 123456, slug: 'shipdok-ab12', name: 'Shipdok-ab12', html_url: 'https://github.com/apps/shipdok-ab12', owner: { login: 'tianyu-00' },
    client_id: 'Iv1.abc', client_secret: 'client-secret-value', webhook_secret: 'hook-secret-0123456789', pem, ...over,
  });

  test('trades the one-time code for the app, sending no credentials, and returns what is needed', async () => {
    const fetch = fakeFetch(() => ({ status: 201, json: converted() }));
    const app = await exchangeManifestCode('abc123DEF456ghi', { fetch });
    assert.equal(fetch.calls[0].url, 'https://api.github.com/app-manifests/abc123DEF456ghi/conversions');
    assert.equal(fetch.calls[0].method, 'POST');
    assert.equal(fetch.calls[0].headers.Authorization, undefined);
    assert.deepEqual({ ...app, privateKeyPem: undefined }, {
      appId: '123456', slug: 'shipdok-ab12', name: 'Shipdok-ab12', htmlUrl: 'https://github.com/apps/shipdok-ab12', ownerLogin: 'tianyu-00',
      clientId: 'Iv1.abc', clientSecret: 'client-secret-value', webhookSecret: 'hook-secret-0123456789', privateKeyPem: undefined,
    });
    assert.equal(parsePrivateKeyPem(app.privateKeyPem).asymmetricKeyType, 'rsa');
  });

  test('refuses a code that could change the address, without calling GitHub', async () => {
    const fetch = fakeFetch(() => ({ status: 201, json: converted() }));
    for (const bad of ['', 'a/b', 'a b', '../x', 'a?b=c', 'x'.repeat(200), undefined, 12]) {
      await assert.rejects(() => exchangeManifestCode(bad, { fetch }), TypeError);
    }
    assert.equal(fetch.calls.length, 0);
  });

  test('a code GitHub does not know (used, expired) is an error carrying only the status', async () => {
    const fetch = fakeFetch(() => ({ status: 404, json: { message: 'Not Found with secret detail' } }));
    await assert.rejects(() => exchangeManifestCode('abc123DEF456ghi', { fetch }), (e) => e instanceof GithubError && e.status === 404 && !/secret/.test(e.message));
  });

  test('GitHub being unreachable is an error without a status', async () => {
    await assert.rejects(() => exchangeManifestCode('abc123DEF456ghi', { fetch: async () => { throw new Error('boom'); } }), (e) => e instanceof GithubError && e.status === undefined);
  });

  for (const [label, over] of [
    ['no app id', { id: undefined }], ['a non-numeric app id', { id: 'abc' }], ['no key', { pem: undefined }], ['a key that is not a key', { pem: 'nope' }],
    ['no webhook secret', { webhook_secret: undefined }], ['an empty webhook secret', { webhook_secret: '' }],
  ]) {
    test(`an answer with ${label} is refused as unusable`, async () => {
      const fetch = fakeFetch(() => ({ status: 201, json: converted(over) }));
      await assert.rejects(() => exchangeManifestCode('abc123DEF456ghi', { fetch }), (e) => e instanceof GithubError && /unexpected/i.test(e.message));
    });
  }

  test('an unusable answer does not leak the key into the error', async () => {
    const fetch = fakeFetch(() => ({ status: 201, json: converted({ id: undefined }) }));
    await assert.rejects(() => exchangeManifestCode('abc123DEF456ghi', { fetch }), (e) => !e.message.includes(pem.split('\n')[1]));
  });

  test('works without a client secret or owner (they are optional)', async () => {
    const fetch = fakeFetch(() => ({ status: 201, json: converted({ client_secret: undefined, owner: undefined }) }));
    const app = await exchangeManifestCode('abc123DEF456ghi', { fetch });
    assert.equal(app.clientSecret, null);
    assert.equal(app.ownerLogin, null);
  });
});

describe('gitAuthEnv', () => {
  const token = 'ghs_exampleTOKEN123';
  const env = gitAuthEnv(token);

  test('sends the token as an HTTP basic auth header for git', () => {
    assert.equal(env.GIT_CONFIG_COUNT, '1');
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraHeader');
    const header = env.GIT_CONFIG_VALUE_0;
    assert.match(header, /^Authorization: Basic /);
    assert.equal(Buffer.from(header.slice('Authorization: Basic '.length), 'base64').toString(), `x-access-token:${token}`);
  });

  test('stops git from prompting for a password', () => {
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  });

  test('is only environment variables: no keys that carry the token', () => {
    assert.ok(Object.keys(env).every((k) => !k.includes(token)));
    assert.ok(!JSON.stringify(Object.keys(env)).includes(token));
  });
});

describe('REPO_FULL_NAME_RE', () => {
  test('accepts ordinary GitHub repository names, dots and all', () => {
    for (const ok of ['tianyu-00/shipdok-test-app', 'a/b', 'o/my.repo', 'o/.github', 'o/a..b', 'o/...', 'My_Org/Repo-1.2']) {
      assert.ok(REPO_FULL_NAME_RE.test(ok), ok);
    }
  });
  test('rejects dot segments, extra slashes, spaces, query strings and injection attempts', () => {
    for (const bad of ['../x', './x', 'o/..', 'o/.', '../..', '/x', 'x/', 'a/b/c', 'a b/c', 'o/r?x=1', 'o/r#f', 'o/r;rm -rf /', 'o/r\n', '', 'o', 'o/r/..']) {
      assert.ok(!REPO_FULL_NAME_RE.test(bad), JSON.stringify(bad));
    }
  });
});
