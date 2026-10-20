// The Docker-facing pieces of the monitor, against fakes: reading a container's facts, probing health once, and
// telling an outside `docker stop` from a crash using Docker's event log.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import {
  containerFacts, probeHealth, classifyEvents, deathCause, containerSpec, setRestartPolicyNone, followLogs, fetchLogs,
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
    assert.deepEqual(f, { status: 'exited', exitCode: 137, oomKilled: true, finishedAt: Date.parse('2026-10-19T10:00:00.500Z'), startedAt: null, deploymentId: null, restartPolicy: 'no' });
  });
  test('also reads when this run started and which deployment the container belongs to', async () => {
    const f = await containerFacts({ async inspect() {
      return { State: { Status: 'running', ExitCode: 0, OOMKilled: false, StartedAt: '2026-10-19T01:02:03.456789012Z', FinishedAt: '0001-01-01T00:00:00Z' },
        HostConfig: { RestartPolicy: { Name: 'no' } }, Config: { Labels: { 'shipdok.deployment-id': 'dep-1', 'shipdok.app-id': 'app-1' } } };
    } });
    assert.equal(f.startedAt, Date.parse('2026-10-19T01:02:03.456Z'));
    assert.equal(f.deploymentId, 'dep-1');
  });

  test('a container with no start time or labels gives null, not a crash', async () => {
    const f = await containerFacts(inspect({ Status: 'created', ExitCode: 0, OOMKilled: false, FinishedAt: '0001-01-01T00:00:00Z', StartedAt: '0001-01-01T00:00:00Z' }));
    assert.deepEqual([f.startedAt, f.deploymentId], [null, null]);
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

describe('persistent storage in a container spec', () => {
  const base = { image: 'img', name: 'n', labels: {}, containerPort: 3000, hostPort: '', memoryMb: 256, cpus: 1, env: [] };
  test('named volumes are mounted by name at the app\'s paths (and only volumes: never a host path)', () => {
    const spec = containerSpec({ ...base, volumes: [{ path: '/data', name: 'shipdok-vol-abc' }] });
    assert.deepEqual(spec.HostConfig.Mounts, [{ Type: 'volume', Source: 'shipdok-vol-abc', Target: '/data' }]);
    assert.ok(!spec.HostConfig.Binds);
  });
  test('without a name it is a throwaway volume (Docker makes an anonymous one)', () => {
    const spec = containerSpec({ ...base, volumes: [{ path: '/data' }] });
    assert.deepEqual(spec.HostConfig.Mounts, [{ Type: 'volume', Target: '/data' }]);
  });
  test('no volumes: no mounts at all', () => {
    assert.ok(!('Mounts' in containerSpec(base).HostConfig));
    assert.ok(!('Mounts' in containerSpec({ ...base, volumes: [] }).HostConfig));
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
  test('a container cannot start unlimited processes (a fork bomb cannot take the machine down)', () => {
    assert.equal(spec.HostConfig.PidsLimit, 512);
  });
  test('but nothing else is taken away: the administrator decided against no-new-privileges and a capability drop, because a repository may need them', () => {
    assert.ok(!('SecurityOpt' in spec.HostConfig));
    assert.ok(!('CapDrop' in spec.HostConfig) && !('CapAdd' in spec.HostConfig));
  });
  test('ports and limits come from the app', () => {
    assert.deepEqual(spec.HostConfig.PortBindings, { '3000/tcp': [{ HostPort: '9100' }] });
    assert.equal(spec.HostConfig.Memory, 256 * 1024 * 1024);
    assert.equal(spec.HostConfig.NanoCpus, 0.5e9);
  });
  test('Docker keeps only a bounded copy of the output (the persistent copy is ours)', () => {
    assert.deepEqual(spec.HostConfig.LogConfig, { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } });
  });
  test('an existing container can be switched to the same policy', async () => {
    let body;
    await setRestartPolicyNone({ update: async (b) => { body = b; } });
    assert.deepEqual(body, { RestartPolicy: { Name: 'no' } });
  });
});

describe('followLogs / fetchLogs', () => {
  const recorder = () => { const seen = {}; return { seen, c: { logs: async (o) => { seen.opts = o; return seen.result ?? Buffer.from('x'); } } }; };

  test('following asks for both streams, with timestamps, and no tail limit', async () => {
    const { seen, c } = recorder();
    await followLogs(c, { since: Date.parse('2026-10-19T01:00:00.250Z') });
    assert.deepEqual(seen.opts, { follow: true, stdout: true, stderr: true, timestamps: true, since: '1792371600.250' });
  });

  test('fetching is a one-off read of the same, bounded by since and until', async () => {
    const { seen, c } = recorder();
    await fetchLogs(c, { since: 1_000_500, until: 2_000_000 });
    assert.deepEqual(seen.opts, { follow: false, stdout: true, stderr: true, timestamps: true, since: '1000.500', until: '2000.000' });
  });

  test('since and until are optional', async () => {
    const { seen, c } = recorder();
    await fetchLogs(c, {});
    assert.deepEqual(seen.opts, { follow: false, stdout: true, stderr: true, timestamps: true });
  });

  test('fetching gives back the bytes', async () => {
    const { seen, c } = recorder();
    seen.result = Buffer.from('frames');
    assert.equal((await fetchLogs(c, {})).toString(), 'frames');
  });
});
