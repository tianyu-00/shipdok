import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, readdirSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecretFiles, ensureSecrets, applyPlatformDefaults, SECRET_FILES, parseMasterKey } from '../src/index.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shipdok-secrets-')); });
const file = (name, content) => { writeFileSync(join(dir, name), content); return join(dir, name); };

describe('loadSecretFiles', () => {
  test('reads a secret from the file named by <NAME>_FILE, without the trailing newline', () => {
    const env = { SESSION_SECRET_FILE: file('session_secret', `${'s'.repeat(64)}\n`) };
    assert.deepEqual(loadSecretFiles(env), ['SESSION_SECRET']);
    assert.equal(env.SESSION_SECRET, 's'.repeat(64));
  });

  test('a value set in the environment always wins and its file is not even read', () => {
    const env = { APP_SECRETS_KEY: 'from-the-environment', APP_SECRETS_KEY_FILE: '/definitely/not/here' };
    assert.deepEqual(loadSecretFiles(env), []);
    assert.equal(env.APP_SECRETS_KEY, 'from-the-environment');
  });

  test('an empty environment value counts as not set (compose passes empty strings for unset variables)', () => {
    const env = { REDIS_PASSWORD: '', REDIS_PASSWORD_FILE: file('redis_password', 'r'.repeat(40)) };
    loadSecretFiles(env);
    assert.equal(env.REDIS_PASSWORD, 'r'.repeat(40));
  });

  test('no file named and nothing set: nothing happens', () => {
    const env = {};
    assert.deepEqual(loadSecretFiles(env), []);
    assert.deepEqual(env, {});
  });

  test('handles every secret Shipdok knows', () => {
    const env = {};
    for (const name of Object.keys(SECRET_FILES)) env[`${name}_FILE`] = file(SECRET_FILES[name].file, `value-of-${name}`);
    assert.deepEqual(loadSecretFiles(env).sort(), Object.keys(SECRET_FILES).sort());
    for (const name of Object.keys(SECRET_FILES)) assert.equal(env[name], `value-of-${name}`);
  });

  test('a file that cannot be read is a clear error that names the setting and the path, never a value', () => {
    assert.throws(() => loadSecretFiles({ SESSION_SECRET_FILE: join(dir, 'missing') }), (e) => /SESSION_SECRET_FILE/.test(e.message) && e.message.includes(join(dir, 'missing')));
  });

  test('an empty file is an error', () => {
    assert.throws(() => loadSecretFiles({ SESSION_SECRET_FILE: file('empty', '\n  \n') }), /empty/i);
  });

  test('a relative path is refused', () => {
    assert.throws(() => loadSecretFiles({ SESSION_SECRET_FILE: 'secrets/session' }), /absolute/i);
  });

  test('a huge file is refused, not loaded', () => {
    assert.throws(() => loadSecretFiles({ SESSION_SECRET_FILE: file('big', 'x'.repeat(20_000)) }), /too large/i);
  });

  test('errors never contain the secret', () => {
    const secret = 'very-secret-value-0123456789';
    try { loadSecretFiles({ SESSION_SECRET_FILE: file('s', `${secret}${'x'.repeat(20_000)}`) }); } catch (e) { assert.ok(!e.message.includes(secret)); }
  });
});

describe('ensureSecrets (what the first-run service does)', () => {
  const names = () => readdirSync(dir).sort();

  test('writes every secret that is missing, nothing else', () => {
    const out = ensureSecrets({ dir, env: {} });
    assert.deepEqual(names(), Object.values(SECRET_FILES).map((s) => s.file).sort());
    assert.deepEqual(out.created.sort(), Object.keys(SECRET_FILES).sort());
    assert.deepEqual(out.fromEnvironment, []);
    assert.deepEqual(out.kept, []);
  });

  test('the values have the right shape', () => {
    ensureSecrets({ dir, env: {} });
    const read = (n) => readFileSync(join(dir, SECRET_FILES[n].file), 'utf8');
    assert.match(read('APP_SECRETS_KEY'), /^[0-9a-f]{64}$/);
    assert.equal(parseMasterKey(read('APP_SECRETS_KEY')).length, 32);
    assert.match(read('SESSION_SECRET'), /^[0-9a-f]{64}$/);
    assert.match(read('POSTGRES_PASSWORD'), /^[0-9a-f]{48}$/);
    assert.match(read('REDIS_PASSWORD'), /^[0-9a-f]{48}$/);
    assert.match(read('SETUP_TOKEN'), /^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/); // typed by hand from a log: no look-alikes
  });

  test('no file ends in a newline (the loader trims anyway, but a copy-paste must not carry one)', () => {
    ensureSecrets({ dir, env: {} });
    for (const n of names()) assert.ok(!readFileSync(join(dir, n), 'utf8').endsWith('\n'), n);
  });

  test('every secret is different from the others, and from run to run', () => {
    ensureSecrets({ dir, env: {} });
    const first = names().map((n) => readFileSync(join(dir, n), 'utf8'));
    assert.equal(new Set(first).size, first.length);
    const dir2 = mkdtempSync(join(tmpdir(), 'shipdok-secrets-'));
    ensureSecrets({ dir: dir2, env: {} });
    const second = readdirSync(dir2).sort().map((n) => readFileSync(join(dir2, n), 'utf8'));
    for (let i = 0; i < first.length; i++) assert.notEqual(first[i], second[i]);
  });

  test('files are readable by the services (0444) and the directory is not writable by them', () => {
    ensureSecrets({ dir, env: {} });
    for (const n of names()) assert.equal(statSync(join(dir, n)).mode & 0o777, 0o444, n);
    assert.equal(statSync(dir).mode & 0o022, 0);
  });

  test('running again keeps what is there and never overwrites', () => {
    ensureSecrets({ dir, env: {} });
    const before = names().map((n) => readFileSync(join(dir, n), 'utf8'));
    const out = ensureSecrets({ dir, env: {} });
    assert.deepEqual(out.created, []);
    assert.deepEqual(out.kept.sort(), Object.keys(SECRET_FILES).sort());
    assert.deepEqual(names().map((n) => readFileSync(join(dir, n), 'utf8')), before);
  });

  test('a secret the administrator gave in the environment is not generated', () => {
    const out = ensureSecrets({ dir, env: { APP_SECRETS_KEY: 'a'.repeat(64), POSTGRES_PASSWORD: 'my-own-password' } });
    assert.deepEqual(out.fromEnvironment.sort(), ['APP_SECRETS_KEY', 'POSTGRES_PASSWORD']);
    assert.ok(!names().includes(SECRET_FILES.APP_SECRETS_KEY.file));
    assert.ok(!names().includes(SECRET_FILES.POSTGRES_PASSWORD.file));
    assert.ok(names().includes(SECRET_FILES.SESSION_SECRET.file));
  });

  test('an empty environment value does not count as given', () => {
    const out = ensureSecrets({ dir, env: { SESSION_SECRET: '', REDIS_PASSWORD: '   ' } });
    assert.deepEqual(out.fromEnvironment, []);
    assert.ok(names().includes(SECRET_FILES.SESSION_SECRET.file));
  });

  test('an existing empty file is replaced (a crashed earlier run must not leave a blank secret)', () => {
    mkdirSync(dir, { recursive: true });
    file(SECRET_FILES.SESSION_SECRET.file, '');
    chmodSync(join(dir, SECRET_FILES.SESSION_SECRET.file), 0o444);
    ensureSecrets({ dir, env: {} });
    assert.match(readFileSync(join(dir, SECRET_FILES.SESSION_SECRET.file), 'utf8'), /^[0-9a-f]{64}$/);
  });

  test('creates the directory when it is missing', () => {
    const nested = join(dir, 'a', 'b');
    ensureSecrets({ dir: nested, env: {} });
    assert.ok(readdirSync(nested).length > 0);
  });

  test('leaves no half-written temporary files behind', () => {
    ensureSecrets({ dir, env: {} });
    assert.ok(names().every((n) => !n.includes('.tmp')));
  });

  test('what it writes is what the loader reads back', () => {
    ensureSecrets({ dir, env: {} });
    const env = {};
    for (const [name, spec] of Object.entries(SECRET_FILES)) env[`${name}_FILE`] = join(dir, spec.file);
    loadSecretFiles(env);
    assert.match(env.APP_SECRETS_KEY, /^[0-9a-f]{64}$/);
    assert.equal(env.SESSION_SECRET, readFileSync(join(dir, SECRET_FILES.SESSION_SECRET.file), 'utf8'));
  });

  test('the summary never contains a value', () => {
    const out = ensureSecrets({ dir, env: {} });
    const text = JSON.stringify(out);
    for (const n of names()) assert.ok(!text.includes(readFileSync(join(dir, n), 'utf8')));
  });
});

describe('applyPlatformDefaults', () => {
  test('the database user and name default to shipdok when unset or empty', () => {
    assert.deepEqual(applyPlatformDefaults({}), { POSTGRES_USER: 'shipdok', POSTGRES_DB: 'shipdok' });
    assert.deepEqual(applyPlatformDefaults({ POSTGRES_USER: '', POSTGRES_DB: '  ' }), { POSTGRES_USER: 'shipdok', POSTGRES_DB: 'shipdok' });
  });

  test('values that are set are left alone, and other settings are not touched', () => {
    const env = applyPlatformDefaults({ POSTGRES_USER: 'me', POSTGRES_DB: 'mine', POSTGRES_PASSWORD: 'pw' });
    assert.deepEqual(env, { POSTGRES_USER: 'me', POSTGRES_DB: 'mine', POSTGRES_PASSWORD: 'pw' });
  });

  test('never invents a password', () => {
    assert.equal(applyPlatformDefaults({}).POSTGRES_PASSWORD, undefined);
  });
});
