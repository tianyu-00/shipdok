// What docker build is given for build-time variables: names as arguments, values only in docker's own environment.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dockerBuildEnvironment } from '../src/buildenv.js';

const WORKER_ENV = {
  PATH: '/usr/bin', HOME: '/home/node', DOCKER_HOST: 'tcp://x:2375', DOCKER_CONFIG: '/cfg', BUILDX_CONFIG: '/bx', XDG_CONFIG_HOME: '/xdg', HTTPS_PROXY: 'http://proxy:3128', LANG: 'C.UTF-8',
  APP_SECRETS_KEY: 'a'.repeat(64), SESSION_SECRET: 'sss', POSTGRES_PASSWORD: 'pg', REDIS_PASSWORD: 'rd', GITHUB_APP_PRIVATE_KEY_FILE: '/k.pem', SHIPDOK_PUBLIC: 'full',
};

describe('the arguments', () => {
  test('only names, never values: `--build-arg NAME` reads the value from docker\'s environment', () => {
    const { args } = dockerBuildEnvironment(['VITE_API=https://api.example.com', 'NPM_TOKEN=s3cr3t'], WORKER_ENV);
    assert.deepEqual(args, ['--build-arg', 'VITE_API', '--build-arg', 'NPM_TOKEN']);
    assert.ok(!args.join(' ').includes('s3cr3t') && !args.join(' ').includes('example.com'));
  });

  test('no build variables: no arguments', () => {
    assert.deepEqual(dockerBuildEnvironment([], WORKER_ENV).args, []);
    assert.deepEqual(dockerBuildEnvironment(undefined, WORKER_ENV).args, []);
  });

  test('the value is everything after the FIRST =, exactly as stored', () => {
    const { env } = dockerBuildEnvironment(['URL=https://h/?a=b=c', 'EMPTY=', 'MULTI=line1\nline2'], WORKER_ENV);
    assert.deepEqual([env.URL, env.EMPTY, env.MULTI], ['https://h/?a=b=c', '', 'line1\nline2']);
  });

  test('a name given twice is passed once', () => {
    assert.deepEqual(dockerBuildEnvironment(['A=1', 'A=2'], WORKER_ENV).args, ['--build-arg', 'A']);
  });
});

describe('docker\'s environment', () => {
  test('has what docker needs and the build variables', () => {
    const { env } = dockerBuildEnvironment(['VITE_API=v'], WORKER_ENV);
    for (const k of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'BUILDX_CONFIG', 'XDG_CONFIG_HOME', 'HTTPS_PROXY', 'LANG']) assert.equal(env[k], WORKER_ENV[k], k);
    assert.equal(env.DOCKER_BUILDKIT, '1');
    assert.equal(env.VITE_API, 'v');
  });

  test('does NOT have the worker\'s own secrets', () => {
    const { env } = dockerBuildEnvironment(['A=1'], WORKER_ENV);
    for (const k of ['APP_SECRETS_KEY', 'SESSION_SECRET', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'GITHUB_APP_PRIVATE_KEY_FILE', 'SHIPDOK_PUBLIC']) assert.ok(!(k in env), k);
  });

  test('DOCKER_BUILDKIT is always 1, whatever the worker was started with', () => {
    assert.equal(dockerBuildEnvironment([], { ...WORKER_ENV, DOCKER_BUILDKIT: '0' }).env.DOCKER_BUILDKIT, '1');
  });
});

describe('names that cannot be used (the API refuses them; this guards against a bad row)', () => {
  for (const bad of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'BUILDKIT_PROGRESS', 'BUILDX_BUILDER', 'LD_PRELOAD', 'XDG_CONFIG_HOME', 'SHIPDOK_X', 'NODE_OPTIONS', '1BAD', 'has-dash', '']) {
    test(`"${bad}" is refused, naming it but never the value`, () => {
      assert.throws(() => dockerBuildEnvironment([`${bad}=topsecretvalue`], WORKER_ENV), (err) => err.message.includes('cannot be used at build time') && !err.message.includes('topsecretvalue'));
    });
  }
  test('an ordinary name is fine', () => {
    assert.doesNotThrow(() => dockerBuildEnvironment(['VITE_X=1', 'NEXT_PUBLIC_Y=2', 'NODE_ENV=production', 'HTTP_PROXY=p'], WORKER_ENV));
  });
});
