import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGitAuth, GitAuthError } from '../src/gitauth.js';

const TOKEN = 'ghs_SECRETTOKEN1234567890';
const mkGithub = (over = {}) => ({
  tokenCalls: [],
  async findInstallationForRepo() { return 42; },
  async getInstallationToken(id, opts) { this.tokenCalls.push({ id, opts }); return TOKEN; },
  ...over,
});
const mkDb = () => ({ saved: [], async setInstallationId(a, i) { this.saved.push([a, i]); } });
const base = { appId: 'a1', repoFullName: 'o/r' };

describe('resolveGitAuth', () => {
  test('no GitHub App configured: anonymous clone', async () => {
    assert.deepEqual(await resolveGitAuth({ ...base, github: null, db: mkDb() }), {});
  });

  test('no GitHub App but the app has an installation: clear failure, not a silent anonymous clone', async () => {
    await assert.rejects(resolveGitAuth({ ...base, github: null, db: mkDb(), installationId: 5 }), GitAuthError);
  });

  test('stored installation: token scoped to this repo with read-only contents; no lookup', async () => {
    const github = mkGithub({ async findInstallationForRepo() { throw new Error('should not look up'); } });
    const { gitEnv } = await resolveGitAuth({ ...base, github, db: mkDb(), installationId: 7 });
    assert.deepEqual(github.tokenCalls, [{ id: 7, opts: { repo: 'o/r', permissions: { contents: 'read' } } }]);
    assert.equal(gitEnv.GIT_CONFIG_KEY_0, 'http.extraHeader');
    assert.equal(gitEnv.GIT_TERMINAL_PROMPT, '0');
  });

  test('no stored installation: looks it up, remembers it, then gets a token', async () => {
    const github = mkGithub(); const db = mkDb();
    const { gitEnv } = await resolveGitAuth({ ...base, github, db });
    assert.deepEqual(db.saved, [['a1', 42]]);
    assert.ok(gitEnv);
  });

  test('not installed anywhere: anonymous (public repositories)', async () => {
    const github = mkGithub({ async findInstallationForRepo() { return null; } });
    assert.deepEqual(await resolveGitAuth({ ...base, github, db: mkDb() }), {});
  });

  test('lookup failure degrades to anonymous with a log line and never leaks details', async () => {
    const logs = [];
    const github = mkGithub({ async findInstallationForRepo() { throw new Error(`boom ${TOKEN}`); } });
    assert.deepEqual(await resolveGitAuth({ ...base, github, db: mkDb(), log: (m) => logs.push(m) }), {});
    assert.ok(!logs.join('\n').includes(TOKEN));
  });

  test('a failing database write does not fail the deploy', async () => {
    const db = { async setInstallationId() { throw new Error('db down'); } };
    const { gitEnv } = await resolveGitAuth({ ...base, github: mkGithub(), db });
    assert.ok(gitEnv);
  });

  test('token failure: safe message with status only, no secrets', async () => {
    const github = mkGithub({ async getInstallationToken() { const e = new Error(`bad ${TOKEN}`); e.status = 403; throw e; } });
    await assert.rejects(resolveGitAuth({ ...base, github, db: mkDb(), installationId: 7 }), (err) => {
      assert.ok(err instanceof GitAuthError);
      assert.match(err.message, /403/);
      assert.ok(!err.message.includes(TOKEN));
      return true;
    });
  });

  test('rejects dot-segment and malformed repository names', async () => {
    for (const repoFullName of ['../x', 'a/..', 'nope', 'a/b/c', undefined]) {
      await assert.rejects(resolveGitAuth({ ...base, repoFullName, github: mkGithub(), db: mkDb(), installationId: 1 }), GitAuthError);
    }
  });
});
