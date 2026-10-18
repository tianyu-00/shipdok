// The real stop/start helpers against fake container objects: Docker answers 304 when a container is already in
// the state you asked for, which is success for us, while every other error must still surface.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stopContainer, startContainer, restartContainer, isRunning } from '../src/docker.js';

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
