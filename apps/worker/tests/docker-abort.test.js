// The real abort plumbing in docker.js (no Docker daemon needed): child processes, sleeps, health polling.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { run, sleep, waitHealthy, isAbort } from '../src/docker.js';

const elapsed = async (fn) => { const t = Date.now(); try { await fn(); } catch (e) { return { ms: Date.now() - t, err: e }; } return { ms: Date.now() - t }; };

describe('run()', () => {
  test('aborting kills a long-running child promptly and rejects with an AbortError', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    const { ms, err } = await elapsed(() => run('sleep', ['30'], { signal: ctl.signal, stdio: 'ignore' }));
    assert.ok(isAbort(err), `expected AbortError, got ${err?.name}: ${err?.message}`);
    assert.ok(ms < 3000, `took ${ms}ms`);
  });

  test('an already-aborted signal never starts the work', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { err } = await elapsed(() => run('sleep', ['30'], { signal: ctl.signal, stdio: 'ignore' }));
    assert.ok(isAbort(err));
  });

  test('without a signal it still reports success and failure normally', async () => {
    await run('true', [], { stdio: 'ignore' });
    await assert.rejects(run('false', [], { stdio: 'ignore' }), /exited 1/);
  });
});

describe('sleep()', () => {
  test('ends early when aborted', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const { ms, err } = await elapsed(() => sleep(10_000, ctl.signal));
    assert.ok(isAbort(err));
    assert.ok(ms < 2000);
  });
  test('completes normally otherwise', async () => {
    assert.equal((await elapsed(() => sleep(20))).err, undefined);
  });
});

describe('waitHealthy()', () => {
  const fakeContainer = (state, port = '9') => ({
    async inspect() { return { State: state, NetworkSettings: { Ports: { '3000/tcp': [{ HostPort: port }] } } }; },
  });

  test('stops promptly when aborted while the app is not answering', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 150);
    const c = fakeContainer({ Running: true }, '1'); // nothing listens on port 1
    const { ms, err } = await elapsed(() => waitHealthy(c, { containerPort: 3000, health: '/health', signal: ctl.signal }));
    assert.ok(isAbort(err));
    assert.ok(ms < 3000, `took ${ms}ms`);
  });

  test('still succeeds against a healthy app', async () => {
    const server = createServer((req, res) => res.end('ok')).listen(0);
    try {
      const port = String(server.address().port);
      await waitHealthy(fakeContainer({ Running: true }, port), { containerPort: 3000, health: '/health' });
    } finally { server.close(); }
  });

  test('still fails fast when the container has exited', async () => {
    const c = fakeContainer({ Running: false, ExitCode: 1, OOMKilled: false });
    await assert.rejects(waitHealthy(c, { containerPort: 3000, health: '/health' }), /exited early \(code 1/);
  });
});
