// The worker's entry script: root only long enough to join the Docker socket's group, then node. Run with a fake `setpriv` that prints what it
// was given, and a real unix socket, so no real privileges are involved.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../docker-entrypoint.sh', import.meta.url));
let dir; let server; let socketPath;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipdok-entry-'));
  const fake = join(dir, 'setpriv');
  // Prints its arguments AND what the command would see in its environment: a process that drops from root to node must not keep root's HOME.
  writeFileSync(fake, '#!/bin/sh\necho "SETPRIV $*"\necho "HOME=$HOME USER=${USER:-} LOGNAME=${LOGNAME:-}"\n');
  chmodSync(fake, 0o755);
  socketPath = join(dir, 'docker.sock');
  server = createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const runFull = (env, args = ['node', 'worker.js']) => execFileSync('sh', [SCRIPT, ...args], {
  env: { PATH: `${dir}:${process.env.PATH}`, HOME: '/root', USER: 'root', LOGNAME: 'root', ...env }, encoding: 'utf8',
}).trim();
const run = (env, args) => runFull(env, args).split('\n')[0]; // the setpriv line only

describe('docker-entrypoint.sh', () => {
  test('as root with a socket: drops to node with exactly the socket\'s group, then runs the command', () => {
    const gid = statSync(socketPath).gid;
    assert.equal(run({ ENTRYPOINT_UID: '0', DOCKER_SOCKET: socketPath }), `SETPRIV --reuid=node --regid=node --groups=${gid} node worker.js`);
  });

  test('the group comes from the socket, whatever its number is', () => {
    const out = run({ ENTRYPOINT_UID: '0', DOCKER_SOCKET: socketPath });
    assert.match(out, new RegExp(`--groups=${statSync(socketPath).gid}\\b`));
    assert.ok(!/--groups=999\b/.test(out) || statSync(socketPath).gid === 999);
  });

  test('as root without a socket: still drops to node, with no extra group', () => {
    assert.equal(run({ ENTRYPOINT_UID: '0', DOCKER_SOCKET: join(dir, 'nope.sock') }), 'SETPRIV --reuid=node --regid=node --clear-groups node worker.js');
  });

  test('something that is not a socket is treated as no socket', () => {
    const plain = join(dir, 'plain');
    writeFileSync(plain, 'x');
    assert.match(run({ ENTRYPOINT_UID: '0', DOCKER_SOCKET: plain }), /--clear-groups/);
  });

  test('not root: runs the command as it is (nothing to drop)', () => {
    assert.equal(run({ ENTRYPOINT_UID: '1000', DOCKER_SOCKET: socketPath }, ['echo', 'hello']), 'hello');
  });

  test('arguments with spaces and quotes arrive intact', () => {
    assert.equal(run({ ENTRYPOINT_UID: '1000' }, ['printf', '%s', 'a b "c" \'d\'']), 'a b "c" \'d\'');
  });

  test('never runs the command itself as root: with uid 0 it always goes through setpriv', () => {
    assert.match(run({ ENTRYPOINT_UID: '0', DOCKER_SOCKET: join(dir, 'x') }, ['echo', 'hi']), /^SETPRIV .* echo hi$/);
  });

  test("after dropping to node the command gets node's home, not root's (git and docker read their config there)", () => {
    const out = runFull({ ENTRYPOINT_UID: '0', DOCKER_SOCKET: socketPath });
    assert.match(out, /HOME=\/home\/node USER=node LOGNAME=node/);
    assert.ok(!out.includes('/root'));
  });

  test('also without a socket', () => {
    assert.match(runFull({ ENTRYPOINT_UID: '0', DOCKER_SOCKET: join(dir, 'nope') }), /HOME=\/home\/node USER=node LOGNAME=node/);
  });

  test('when not root nothing about the environment is changed', () => {
    const out = execFileSync('sh', [SCRIPT, 'sh', '-c', 'echo "HOME=$HOME"'], { env: { PATH: process.env.PATH, ENTRYPOINT_UID: '1000', HOME: '/home/someone' }, encoding: 'utf8' }).trim();
    assert.equal(out, 'HOME=/home/someone');
  });

  test('a failure of the command is passed on (exit code kept)', () => {
    assert.throws(() => execFileSync('sh', [SCRIPT, 'false'], { env: { ENTRYPOINT_UID: '1000', PATH: process.env.PATH } }), (e) => e.status === 1);
  });
});
