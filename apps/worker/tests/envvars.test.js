import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppEnv, EnvDecryptError } from '../src/envvars.js';
import { pool, KEY, OTHER_KEY, SECRET, ready, reset, makeApp, addVar, versionsOf } from './helpers.js';

before(ready);
beforeEach(reset);
after(() => pool.end());

describe('loadAppEnv: where a variable is available', () => {
  test('runtime goes to the container only, build to docker build only, both to both', async () => {
    const id = await makeApp();
    await addVar(id, 'RUN_ONLY', 'r', KEY, 'runtime');
    await addVar(id, 'BUILD_ONLY', 'b', KEY, 'build');
    await addVar(id, 'BOTH', 'x', KEY, 'both');
    const { env, buildEnv, versions } = await loadAppEnv(pool, id, KEY);
    assert.deepEqual(env, ['BOTH=x', 'RUN_ONLY=r']);
    assert.deepEqual(buildEnv, ['BOTH=x', 'BUILD_ONLY=b']);
    assert.deepEqual(Object.keys(versions), ['BOTH', 'BUILD_ONLY', 'RUN_ONLY']); // every variable has a version, whatever its scope
  });

  test('a variable added without a scope (every one from before this existed) is runtime-only', async () => {
    const id = await makeApp();
    await pool.query('INSERT INTO app_env_vars (app_id, key, value_encrypted) VALUES ($1, $2, $3)', [id, 'OLD', (await import('@shipdok/shared')).encryptSecret('v', KEY, (await import('@shipdok/shared')).envVarContext(id, 'OLD'))]);
    const { env, buildEnv } = await loadAppEnv(pool, id, KEY);
    assert.deepEqual([env, buildEnv], [['OLD=v'], []]);
  });

  test('a build-only variable that cannot be decrypted still fails the deployment with its name, never its value', async () => {
    const id = await makeApp();
    await addVar(id, 'TOKEN', SECRET, OTHER_KEY, 'build');
    await assert.rejects(loadAppEnv(pool, id, KEY), (err) => err instanceof EnvDecryptError && err.message.includes('TOKEN') && !err.message.includes(SECRET));
  });
});

describe('loadAppEnv', () => {
  test('returns KEY=value pairs ready for Docker, sorted by name, with their versions', async () => {
    const id = await makeApp();
    await addVar(id, 'ZED', 'last');
    await addVar(id, 'DATABASE_URL', 'postgres://u:p@host:5432/db');
    const { env, versions } = await loadAppEnv(pool, id, KEY);
    assert.deepEqual(env, ['DATABASE_URL=postgres://u:p@host:5432/db', 'ZED=last']);
    assert.deepEqual(versions, await versionsOf(id));
    assert.deepEqual(Object.keys(versions), ['DATABASE_URL', 'ZED']);
  });

  test('preserves awkward values exactly: =, #, quotes, unicode, newlines, empty', async () => {
    const id = await makeApp();
    const values = { A: 'x=y#z "q" \'s\'', B: 'pässwörd-密码-🔑', C: 'line1\nline2\n', D: '' };
    for (const [k, v] of Object.entries(values)) await addVar(id, k, v);
    const { env } = await loadAppEnv(pool, id, KEY);
    assert.deepEqual(env, Object.entries(values).map(([k, v]) => `${k}=${v}`));
  });

  test('an app with no variables gives empty results', async () => {
    const id = await makeApp();
    assert.deepEqual(await loadAppEnv(pool, id, KEY), { env: [], buildEnv: [], versions: {} });
  });

  test('only returns the requested app\'s variables', async () => {
    const a = await makeApp();
    const b = await makeApp();
    await addVar(a, 'MINE', '1');
    await addVar(b, 'THEIRS', '2');
    assert.deepEqual((await loadAppEnv(pool, a, KEY)).env, ['MINE=1']);
  });

  test('a wrong key fails with a safe error that names the variable but never a value', async () => {
    const id = await makeApp();
    await addVar(id, 'DATABASE_URL', SECRET);
    await assert.rejects(loadAppEnv(pool, id, OTHER_KEY), (err) => {
      assert.ok(err instanceof EnvDecryptError);
      assert.match(err.message, /Could not decrypt the variable "DATABASE_URL"/);
      assert.match(err.message, /APP_SECRETS_KEY/);
      assert.ok(!err.message.includes(SECRET));
      return true;
    });
  });

  test('a ciphertext moved from another app or variable name is refused', async () => {
    const a = await makeApp();
    const b = await makeApp();
    await addVar(a, 'TOKEN', SECRET);
    const { rows } = await pool.query('SELECT value_encrypted FROM app_env_vars WHERE app_id = $1', [a]);
    await pool.query('INSERT INTO app_env_vars (app_id, key, value_encrypted) VALUES ($1, $2, $3)', [b, 'TOKEN', rows[0].value_encrypted]);
    await assert.rejects(loadAppEnv(pool, b, KEY), EnvDecryptError);
    await pool.query(`UPDATE app_env_vars SET key = 'RENAMED' WHERE app_id = $1`, [a]);
    await assert.rejects(loadAppEnv(pool, a, KEY), EnvDecryptError);
  });

  test('one corrupted row fails the whole load rather than starting an app with missing config', async () => {
    const id = await makeApp();
    await addVar(id, 'GOOD', 'fine');
    await pool.query(`INSERT INTO app_env_vars (app_id, key, value_encrypted) VALUES ($1, 'BAD', 'v1:AAAA:BBBB:CCCC')`, [id]);
    await assert.rejects(loadAppEnv(pool, id, KEY), /variable "BAD"/);
  });
});
