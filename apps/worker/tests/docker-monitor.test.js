// The Docker-facing pieces of the monitor, against fakes: reading a container's facts, probing health once, and
// telling an outside `docker stop` from a crash using Docker's event log.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import {
  containerFacts, probeHealth, classifyEvents, deathCause, containerSpec, setRestartPolicyNone,
} from '../src/docker.js';

const ev = (Action, attrs = {}) => ({ Action, Actor: { Attributes: attrs } });

describe('classifyEvents (what the event log says about an exit)', () => {
  test('a die with nothing before it is the process dying on its own: a crash', () => {
    assert.equal(classifyEvents([ev('die', { exitCode: '1' })]), 'crash');
    assert.equal(classifyEvents([ev('die', { exitCode: '0' })]), 'crash', 'a clean exit nobody asked for is still unexpected');
  });
  test('an out-of-memory kill is a crash', () => {
    assert.equal(classifyEvents([ev('oom'), ev('die', { exitCode: '137' })]), 'crash');
  });
  test('docker stop (kill with SIGTERM, then stop) is an outside stop', () => {
    assert.equal(classifyEvents([ev('kill', { signal: '15' }), ev('stop'), ev('die', { exitCode: '0' })]), 'outside');
  });
  test('docker kill is an outside stop', () => {
    assert.equal(classifyEvents([ev('kill', { signal: '9' }), ev('die', { exitCode: '137' })]), 'outside');
  });
  test('a stop that Docker had to force (SIGTERM then SIGKILL) is still an outside stop', () => {
    assert.equal(classifyEvents([ev('kill', { signal: '15' }), ev('kill', { signal: '9' }), ev('stop'), ev('die', { exitCode: '137' })]), 'outside');
  });
  test('no die event at all (history gone after a daemon restart) means we cannot know', () => {
    assert.equal(classifyEvents([]), 'unknown');
    assert.equal(classifyEvents([ev('kill', { signal: '15' })]), 'unknown');
  });
});

describe('containerFacts', () => {
  const inspect = (State, RestartPolicy = { Name: 'no' }) => ({ async inspect() { return { State, HostConfig: { RestartPolicy } }; } });

  test('reads status, exit code, out-of-memory flag and when it ended', async () => {
    const f = await containerFacts(inspect({ Status: 'exited', ExitCode: 137, OOMKilled: true, FinishedAt: '2026-10-19T10:00:00.500Z' }));
    assert.deepEqual(f, { status: 'exited', exitCode: 137, oomKilled: true, finishedAt: Date.parse('2026-10-19T10:00:00.500Z'), restartPolicy: 'no' });
  });
  test('a container that never ran has no end time (Docker uses year 1)', async () => {
    const f = await containerFacts(inspect({ Status: 'created', ExitCode: 0, OOMKilled: false, FinishedAt: '0001-01-01T00:00:00Z' }));
    assert.equal(f.finishedAt, null);
  });
  test('a running container has no end time either', async () => {
    const f = await containerFacts(inspect({ Status: 'running', ExitCode: 0, OOMKilled: false, FinishedAt: '0001-01-01T00:00:00Z' }, { Name: 'on-failure' }));
    assert.deepEqual([f.status, f.finishedAt, f.restartPolicy], ['running', null, 'on-failure']);
  });
});

describe('probeHealth (one attempt, no waiting)', () => {
  const fake = (port) => ({ async inspect() { return { NetworkSettings: { Ports: { '3000/tcp': [{ HostPort: String(port) }] } } }; } });
  const serve = (handler) => new Promise((resolve) => { const s = createServer(handler).listen(0, '127.0.0.1', () => resolve(s)); });

  test('true for a 2xx, false for an error status', async () => {
    let code = 200;
    const s = await serve((req, res) => { res.writeHead(code); res.end('x'); });
    try {
      const c = fake(s.address().port);
      assert.equal(await probeHealth(c, { containerPort: 3000, health: '/health' }), true);
      code = 500;
      assert.equal(await probeHealth(c, { containerPort: 3000, health: '/health' }), false);
    } finally { s.close(); }
  });
  test('false when nothing is listening, and it does not hang', async () => {
    const t = Date.now();
    assert.equal(await probeHealth(fake(1), { containerPort: 3000, health: '/health' }), false);
    assert.ok(Date.now() - t < 3500);
  });
  test('false when the server never answers (times out)', async () => {
    const s = await serve(() => {});
    try {
      const t = Date.now();
      assert.equal(await probeHealth(fake(s.address().port), { containerPort: 3000, health: '/health' }, { timeoutMs: 300 }), false);
      assert.ok(Date.now() - t < 2000);
    } finally { s.closeAllConnections?.(); s.close(); }
  });
});

describe('deathCause', () => {
  const streamOf = (events) => Readable.from([events.map((e) => JSON.stringify(e)).join('\n') + '\n']);
  const dockerWith = (events, seen = {}) => ({ getEvents: async (opts) => { seen.opts = opts; return streamOf(events); } });

  test('asks only about this container and only for the events that matter', async () => {
    const seen = {};
    await deathCause({ id: 'abc123' }, Date.parse('2026-10-19T10:00:00Z'), { docker: dockerWith([ev('die', { exitCode: '1' })], seen) });
    assert.deepEqual(seen.opts.filters, { container: ['abc123'], event: ['kill', 'stop', 'die', 'oom'] });
    assert.ok(seen.opts.since <= Date.parse('2026-10-19T10:00:00Z') / 1000, 'starts a little before the exit');
  });
  test('classifies what comes back', async () => {
    assert.equal(await deathCause({ id: 'a' }, Date.now(), { docker: dockerWith([ev('die')]) }), 'crash');
    assert.equal(await deathCause({ id: 'a' }, Date.now(), { docker: dockerWith([ev('kill', { signal: '9' }), ev('die')]) }), 'outside');
    assert.equal(await deathCause({ id: 'a' }, Date.now(), { docker: dockerWith([]) }), 'unknown');
  });
  test('an events API that fails or hangs means "unknown", never a guess', async () => {
    assert.equal(await deathCause({ id: 'a' }, Date.now(), { docker: { getEvents: async () => { throw new Error('boom'); } } }), 'unknown');
    const hang = { getEvents: async () => new Readable({ read() {} }) };
    const t = Date.now();
    assert.equal(await deathCause({ id: 'a' }, Date.now(), { docker: hang, timeoutMs: 300 }), 'unknown');
    assert.ok(Date.now() - t < 2000);
  });
  test('ignores lines that are not JSON', async () => {
    const s = Readable.from(['not json\n' + JSON.stringify(ev('die')) + '\n']);
    assert.equal(await deathCause({ id: 'a' }, Date.now(), { docker: { getEvents: async () => s } }), 'crash');
  });
});

describe('what a new container is created with', () => {
  const spec = containerSpec({
    image: 'img', name: 'n', labels: { a: 'b' }, containerPort: 3000, hostPort: 9100, memoryMb: 256, cpus: 0.5, env: ['A=1'],
  });
  test('Docker\'s own restart policy is off: Shipdok decides about restarts', () => {
    assert.deepEqual(spec.HostConfig.RestartPolicy, { Name: 'no' });
  });
  test('the safety settings are unchanged: no privileged mode, no socket, no host mounts', () => {
    assert.ok(!spec.HostConfig.Privileged);
    assert.ok(!spec.HostConfig.Binds && !spec.HostConfig.Mounts);
    assert.ok(!JSON.stringify(spec).includes('docker.sock'));
  });
  test('ports and limits come from the app', () => {
    assert.deepEqual(spec.HostConfig.PortBindings, { '3000/tcp': [{ HostPort: '9100' }] });
    assert.equal(spec.HostConfig.Memory, 256 * 1024 * 1024);
    assert.equal(spec.HostConfig.NanoCpus, 0.5e9);
  });
  test('an existing container can be switched to the same policy', async () => {
    let body;
    await setRestartPolicyNone({ update: async (b) => { body = b; } });
    assert.deepEqual(body, { RestartPolicy: { Name: 'no' } });
  });
});
