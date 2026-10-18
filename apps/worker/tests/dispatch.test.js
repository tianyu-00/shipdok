// worker.js hands every job to one function; control jobs and deploy jobs must reach the right processor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobProcessor } from '../src/dispatch.js';

const make = () => {
  const calls = [];
  const process = jobProcessor({
    deploy: async (job) => { calls.push(['deploy', job.name]); return 'd'; },
    control: async (job) => { calls.push(['control', job.name]); return 'c'; },
  });
  return { calls, process };
};

test('a control job goes to the control processor', async () => {
  const { calls, process } = make();
  assert.equal(await process({ name: 'control' }), 'c');
  assert.deepEqual(calls, [['control', 'control']]);
});

test('a deploy job goes to the deploy processor', async () => {
  const { calls, process } = make();
  assert.equal(await process({ name: 'deploy' }), 'd');
  assert.deepEqual(calls, [['deploy', 'deploy']]);
});

test('jobs queued before names mattered (any other name) are still treated as deployments', async () => {
  const { calls, process } = make();
  await process({ name: '__default__' });
  assert.deepEqual(calls, [['deploy', '__default__']]);
});
