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

test('the app is marked busy while its job runs, and free afterwards, even if the job fails', async () => {
  const marks = [];
  const activity = { run: async (id, fn) => { marks.push(['start', id]); try { return await fn(); } finally { marks.push(['end', id]); } } };
  const process = jobProcessor({ activity, deploy: async () => { throw new Error('boom'); }, control: async () => 'c' });
  assert.equal(await process({ name: 'control', data: { appId: 'a1' } }), 'c');
  await assert.rejects(process({ name: 'deploy', data: { appId: 'a2' } }), /boom/);
  assert.deepEqual(marks, [['start', 'a1'], ['end', 'a1'], ['start', 'a2'], ['end', 'a2']]);
});

test('a job without an app id still runs (nothing to mark)', async () => {
  const process = jobProcessor({ activity: { run: () => { throw new Error('should not be used'); } }, deploy: async () => 'd', control: async () => 'c' });
  assert.equal(await process({ name: 'deploy', data: {} }), 'd');
});
