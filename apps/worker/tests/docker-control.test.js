// The real stop/start helpers against fake container objects: Docker answers 304 when a container is already in
// the state you asked for, which is success for us, while every other error must still surface.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stopContainer, startContainer, restartContainer, isRunning, run, removeQuietly, ensureVolume, removeVolumeStrict } from '../src/docker.js';

const dockerError = (statusCode, message = 'boom') => Object.assign(new Error(message), { statusCode });

describe('stopContainer / startContainer', () => {
  test('"already stopped" (304) is fine', async () => {
    await stopContainer({ stop: async () => { throw dockerError(304); } });
  });
  test('"already started" (304) is fine', async () => {
    await startContainer({ start: async () => { throw dockerError(304); } });
  });
  test('any other failure is not hidden', async () => {
    await assert.rejects(stopContainer({ stop: async () => { throw dockerError(500, 'daemon error'); } }), /daemon error/);
    await assert.rejects(startContainer({ start: async () => { throw dockerError(409, 'port is already allocated'); } }), /already allocated/);
    await assert.rejects(startContainer({ start: async () => { throw new Error('no status code'); } }), /no status code/);
  });
  test('stop gives the app time to shut down before Docker kills it', async () => {
    let opts;
    await stopContainer({ stop: async (o) => { opts = o; } });
    assert.deepEqual(opts, { t: 10 });
  });
});

describe('restartContainer / isRunning', () => {
  test('restart waits for a graceful shutdown too', async () => {
    let opts;
    await restartContainer({ restart: async (o) => { opts = o; } });
    assert.deepEqual(opts, { t: 10 });
  });
  test('isRunning reports Docker\'s own view', async () => {
    assert.equal(await isRunning({ inspect: async () => ({ State: { Running: true } }) }), true);
    assert.equal(await isRunning({ inspect: async () => ({ State: { Running: false } }) }), false);
  });
});

describe('run() with a log sink', () => {
  const collect = () => {
    const got = [];
    return { got, write: (stream, chunk) => got.push([stream, chunk.toString()]) };
  };
  const text = (got, stream) => got.filter(([s]) => s === stream).map(([, c]) => c).join('');

  test('sends what the command prints to the sink, stdout and stderr apart', async () => {
    const sink = collect();
    await run('sh', ['-c', 'echo to-out; echo to-err >&2'], { sink });
    assert.equal(text(sink.got, 'stdout'), 'to-out\n');
    assert.equal(text(sink.got, 'stderr'), 'to-err\n');
  });

  test('a failing command still delivers everything it printed BEFORE the failure is reported', async () => {
    const sink = collect();
    await assert.rejects(run('sh', ['-c', 'echo before; echo oops >&2; exit 3'], { sink }), /exited 3/);
    assert.equal(text(sink.got, 'stdout'), 'before\n');
    assert.equal(text(sink.got, 'stderr'), 'oops\n');
  });

  test('a lot of output arrives complete', async () => {
    const sink = collect();
    await run('sh', ['-c', 'i=0; while [ $i -lt 2000 ]; do echo "line $i"; i=$((i+1)); done'], { sink });
    assert.equal(text(sink.got, 'stdout').trimEnd().split('\n').length, 2000);
  });

  test('a command that prints a lot and exits at once loses none of its last lines', async () => {
    const sink = collect();
    await run('sh', ['-c', 'yes "0123456789012345678901234567890123456789012345678901234567890123456789" | head -n 60000'], { sink });
    assert.equal(text(sink.got, 'stdout').trimEnd().split('\n').length, 60000);
  });

  test('without a sink nothing changes: output goes to the worker\'s own console', async () => {
    await run('true', [], { stdio: 'ignore' });
  });

  test('the sink never reaches the child process (it is not passed on to spawn)', async () => {
    const sink = collect();
    await run('sh', ['-c', 'echo ok'], { sink, env: { PATH: process.env.PATH } });
    assert.equal(text(sink.got, 'stdout'), 'ok\n');
  });

  test('aborting still stops the command and rejects', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    await assert.rejects(run('sleep', ['30'], { sink: collect(), signal: ctl.signal }), (e) => e.name === 'AbortError');
  });
});

describe('volumes', () => {
  test('removing a container also removes ITS anonymous volumes (the throwaway ones of a candidate); named volumes are never named in the call', async () => {
    let opts;
    await removeQuietly({ remove: async (o) => { opts = o; } });
    assert.deepEqual(opts, { force: true, v: true });
  });

  test('ensureVolume creates it with its name and labels (and is happy if it exists: Docker answers with the existing one)', async () => {
    let made;
    await ensureVolume({ name: 'shipdok-vol-abc', labels: { 'shipdok.managed': 'true' } }, { docker: { createVolume: async (o) => { made = o; } } });
    assert.deepEqual(made, { Name: 'shipdok-vol-abc', Labels: { 'shipdok.managed': 'true' } });
  });

  const dockerWith = (inspect, remove = async () => {}) => ({ getVolume: () => ({ inspect, remove }) });
  test('removeVolumeStrict removes only a volume Shipdok made', async () => {
    let removed = 0;
    const d = dockerWith(async () => ({ Labels: { 'shipdok.managed': 'true' } }), async () => { removed += 1; });
    assert.equal(await removeVolumeStrict('shipdok-vol-abc', { docker: d }), 'removed');
    assert.equal(removed, 1);
  });
  test('a volume without the ownership label is refused, and not touched', async () => {
    let removed = 0;
    const d = dockerWith(async () => ({ Labels: { other: '1' } }), async () => { removed += 1; });
    await assert.rejects(removeVolumeStrict('shipdok-vol-nolabel', { docker: d }), /does not belong to Shipdok/);
    assert.equal(removed, 0);
  });
  test('a name that is not one of ours is refused before Docker is asked', async () => {
    await assert.rejects(removeVolumeStrict('my-database', { docker: dockerWith(async () => { throw new Error('asked'); }) }), /does not belong to Shipdok/);
  });
  test('gone (404) and in use (409) are told apart; anything else surfaces', async () => {
    const err = (code) => Object.assign(new Error('x'), { statusCode: code });
    assert.equal(await removeVolumeStrict('shipdok-vol-a', { docker: dockerWith(async () => { throw err(404); }) }), 'gone');
    assert.equal(await removeVolumeStrict('shipdok-vol-a', { docker: dockerWith(async () => ({ Labels: { 'shipdok.managed': 'true' } }), async () => { throw err(409); }) }), 'in-use');
    await assert.rejects(removeVolumeStrict('shipdok-vol-a', { docker: dockerWith(async () => { throw err(500); }) }));
  });
});
