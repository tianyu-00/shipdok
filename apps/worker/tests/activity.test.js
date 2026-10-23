// The per-app "a job is working on this app" marker the monitor respects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivity } from '../src/activity.js';

test('an app is busy only while its job runs', async () => {
  const a = createActivity();
  assert.equal(a.isBusy('x'), false);
  let during;
  const out = await a.run('x', async () => { during = a.isBusy('x'); return 42; });
  assert.deepEqual([out, during, a.isBusy('x')], [42, true, false]);
});

test('other apps are not affected', async () => {
  const a = createActivity();
  await a.run('x', async () => { assert.equal(a.isBusy('y'), false); });
});

test('a failing job still clears the marker, and the error is not swallowed', async () => {
  const a = createActivity();
  await assert.rejects(a.run('x', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(a.isBusy('x'), false);
});

test('overlapping runs on one app keep it busy until the last one ends', async () => {
  const a = createActivity();
  let release;
  const first = a.run('x', () => new Promise((r) => { release = r; }));
  await a.run('x', async () => {});
  assert.equal(a.isBusy('x'), true);
  release();
  await first;
  assert.equal(a.isBusy('x'), false);
});

test('begin() marks an app busy until the returned function is called, once only', () => {
  const a = createActivity();
  const end = a.begin('x');
  const other = a.begin('x');
  assert.equal(a.isBusy('x'), true);
  end(); end(); // (a second call changes nothing)
  assert.equal(a.isBusy('x'), true, 'the other hold is still there');
  other();
  assert.equal(a.isBusy('x'), false);
});
