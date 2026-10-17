// The worker's status helpers against real Postgres: every update is guarded so a final status sticks.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as d from '../src/db.js';
import { pool, ready, reset, makeApp, makeDeployment, getDeployment } from './helpers.js';

before(ready);
beforeEach(reset);
after(() => pool.end());

const fresh = async () => makeDeployment(await makeApp());
const setRow = (id, sql, params = []) => pool.query(`UPDATE deployments SET ${sql} WHERE id = $1`, [id, ...params]);

test('queued -> building -> starting -> validating -> successful', async () => {
  const id = await fresh();
  assert.equal(await d.claim(id), true);
  assert.ok((await getDeployment(id)).started_at);
  await d.setCommit(id, 'abc123');
  await d.setStatus(id, 'starting');
  await d.setStatus(id, 'validating');
  assert.equal((await getDeployment(id)).status, 'validating');
  await d.markSucceeded(id, 'shipdok/t:img');
  const row = await getDeployment(id);
  assert.deepEqual([row.status, row.image_ref, row.commit_sha], ['successful', 'shipdok/t:img', 'abc123']);
  assert.ok(row.finished_at);
});

test('claim succeeds exactly once, so two workers can never both take a deployment', async () => {
  const id = await fresh();
  const results = await Promise.all([d.claim(id), d.claim(id), d.claim(id)]);
  assert.deepEqual(results.filter(Boolean), [true]);
});

test('claim refuses anything that is not queued', async () => {
  for (const status of ['building', 'cancelled', 'superseded', 'successful', 'failed', 'interrupted']) {
    const id = await fresh();
    await setRow(id, 'status = $2', [status]);
    assert.equal(await d.claim(id), false, status);
    assert.equal((await getDeployment(id)).status, status);
  }
});

test('a final status can never be overwritten', async () => {
  const id = await fresh();
  await d.claim(id);
  await d.markSucceeded(id, 'img');
  await d.markFailed(id, 'late failure');
  await d.markStopped(id, 'cancelled');
  await d.setStatus(id, 'building');
  await d.recordEnvVersions(id, { LATE: '1' });
  const row = await getDeployment(id);
  assert.equal(row.status, 'successful');
  assert.equal(row.error_summary, null);
  assert.equal(row.config_snapshot.env, undefined);
});

test('failure is recorded and the error text is capped at 500 characters', async () => {
  const id = await fresh();
  await d.claim(id);
  await d.markFailed(id, 'x'.repeat(5000));
  const row = await getDeployment(id);
  assert.equal(row.status, 'failed');
  assert.equal(row.error_summary.length, 500);
});

test('recordEnvVersions adds the env map and keeps the rest of the snapshot', async () => {
  const id = await makeDeployment(await makeApp(), { branch: 'main', host_port: 8080 });
  await d.recordEnvVersions(id, { A: '5', B: '9' });
  assert.deepEqual((await getDeployment(id)).config_snapshot, { branch: 'main', host_port: 8080, env: { A: '5', B: '9' } });
});

test('interruptActive marks only in-flight rows; queued and finished rows are untouched', async () => {
  const appId = await makeApp();
  const queued = await makeDeployment(appId);
  const building = await makeDeployment(appId);
  const validating = await makeDeployment(appId);
  const finished = await makeDeployment(appId);
  await d.claim(building);
  await d.claim(validating); await d.setStatus(validating, 'validating');
  await d.claim(finished); await d.markSucceeded(finished, 'i');

  assert.equal(await d.interruptActive(), 2);
  const status = async (id) => (await getDeployment(id)).status;
  assert.deepEqual(
    [await status(queued), await status(building), await status(validating), await status(finished)],
    ['queued', 'interrupted', 'interrupted', 'successful'],
  );
  const row = await getDeployment(building);
  assert.ok(row.finished_at);
  assert.match(row.error_summary, /worker stopped/);
});

test("a stall handler cannot turn 'interrupted' into 'failed'", async () => {
  const id = await fresh();
  await d.claim(id);
  await d.interruptActive();
  await d.markFailed(id, 'job stalled more than allowable limit');
  assert.equal((await getDeployment(id)).status, 'interrupted');
});

// ---- cancellation helpers ----

test('getCancelStatus reports a request, or null', async () => {
  const id = await fresh();
  assert.equal(await d.getCancelStatus(id), null);
  await setRow(id, `cancel_status = 'cancelled'`);
  assert.equal(await d.getCancelStatus(id), 'cancelled');
  assert.equal(await d.getCancelStatus('00000000-0000-0000-0000-000000000000'), null);
});

test('markStopped ends a deployment as cancelled, or as superseded with its link', async () => {
  const appId = await makeApp();
  const a = await makeDeployment(appId);
  const b = await makeDeployment(appId);
  const winner = await makeDeployment(appId);
  await d.claim(a); await d.claim(b);

  await d.markStopped(a, 'cancelled');
  await d.markStopped(b, 'superseded', winner);

  const ra = await getDeployment(a);
  assert.deepEqual([ra.status, ra.cancel_status, ra.error_summary], ['cancelled', 'cancelled', 'Cancelled by the administrator']);
  const rb = await getDeployment(b);
  assert.deepEqual([rb.status, rb.cancel_status, rb.superseded_by, rb.error_summary], ['superseded', 'superseded', winner, 'Superseded by a newer deployment']);
  assert.ok(ra.finished_at && rb.finished_at);
});

test('markStopped keeps an existing superseded_by link when none is given', async () => {
  const appId = await makeApp();
  const a = await makeDeployment(appId);
  const winner = await makeDeployment(appId);
  await d.claim(a);
  await setRow(a, `cancel_status = 'superseded', superseded_by = $2`, [winner]);
  await d.markStopped(a, 'superseded');
  assert.equal((await getDeployment(a)).superseded_by, winner);
});

test('markSucceeded after a too-late cancel clears the flag and leaves an honest note', async () => {
  const id = await fresh();
  await d.claim(id);
  await setRow(id, `cancel_status = 'cancelled'`);
  await d.markSucceeded(id, 'img');
  const row = await getDeployment(id);
  assert.deepEqual([row.status, row.cancel_status], ['successful', null]);
  assert.match(row.error_summary, /too late/);
});

test('markSucceeded without any cancel request leaves no note', async () => {
  const id = await fresh();
  await d.claim(id);
  await d.markSucceeded(id, 'img');
  assert.equal((await getDeployment(id)).error_summary, null);
});

test('newerSuccess finds a newer successful deployment of the SAME app only', async () => {
  const appA = await makeApp();
  const appB = await makeApp();
  const older = await makeDeployment(appA);
  const newerFailed = await makeDeployment(appA);
  const otherApp = await makeDeployment(appB);
  await setRow(newerFailed, `status = 'failed'`);
  await setRow(otherApp, `status = 'successful'`);
  assert.equal(await d.newerSuccess(older), null);

  const newerOk = await makeDeployment(appA);
  await setRow(newerOk, `status = 'successful'`);
  assert.equal(await d.newerSuccess(older), newerOk);
  assert.equal(await d.newerSuccess(newerOk), null); // nothing newer than the newest
});

test('newerSuccess returns the most recent when several are newer', async () => {
  const appId = await makeApp();
  const older = await makeDeployment(appId);
  const mid = await makeDeployment(appId);
  const newest = await makeDeployment(appId);
  await setRow(mid, `status = 'successful'`);
  await setRow(newest, `status = 'successful'`);
  assert.equal(await d.newerSuccess(older), newest);
});
