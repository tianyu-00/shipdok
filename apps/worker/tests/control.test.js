// Start / stop / restart as the worker carries them out, against a fake Docker and the real test database.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/db.js';
import { controlApp, processControlJob } from '../src/control.js';
import { pool, ready, reset, makeApp } from './helpers.js';
import { fakeEngine } from './fake-engine.js';

before(ready);
beforeEach(reset);
after(() => pool.end());

const noLog = () => {};
const runtime = async (appId) => (await pool.query('SELECT * FROM app_runtime WHERE app_id = $1', [appId])).rows[0];
const setHealth = (appId, path) => pool.query('UPDATE apps SET health_path = $2 WHERE id = $1', [appId, path]);
const go = (appId, action, eng) => controlApp({ appId, action }, { eng, db: store, log: noLog });

describe('stop', () => {
  test('stops every live container of the app and records that it is stopped', async () => {
    const appId = await makeApp();
    const eng = fakeEngine({ previous: ['live-1', 'live-2'] });
    const r = await go(appId, 'stop', eng);
    assert.equal(r.ok, true);
    assert.deepEqual(eng.events, ['stop live-1', 'stop live-2']);
    assert.deepEqual(eng.lookups, [{ appId, role: 'live' }]); // only this app's live containers, never candidates
    assert.deepEqual(
      { state: (await runtime(appId)).state, action: (await runtime(appId)).last_action, error: (await runtime(appId)).last_error },
      { state: 'stopped', action: 'stop', error: null },
    );
  });

  test('does not remove anything: configuration, image and container all stay for a later start', async () => {
    const appId = await makeApp();
    const eng = fakeEngine({ previous: ['live-1'] });
    await go(appId, 'stop', eng);
    assert.ok(!eng.events.some((e) => e.startsWith('remove')));
  });
});

describe('start', () => {
  test('starts the existing container, waits for the health check the app is configured with, then records running', async () => {
    const appId = await makeApp();
    await setHealth(appId, '/health');
    const seen = [];
    const eng = fakeEngine({ previous: ['live-1'], stopped: ['live-1'] });
    const wait = eng.waitHealthy;
    eng.waitHealthy = async (c, opts) => { seen.push(opts); await wait(c, opts); };

    const r = await go(appId, 'start', eng);
    assert.equal(r.ok, true);
    assert.deepEqual(eng.events, ['start live-1', 'health live-1']);
    assert.equal(seen[0].containerPort, 3000);
    assert.equal(seen[0].health, '/health');
    assert.equal((await runtime(appId)).state, 'running');
  });

  test('a container that starts but fails its health check is reported unhealthy and is left running', async () => {
    const appId = await makeApp();
    const eng = fakeEngine({ previous: ['live-1'], health: { live: async () => { throw new Error('Health check timed out after 120s'); } } });
    const r = await go(appId, 'start', eng);
    assert.equal(r.ok, true, 'the action itself worked: the container is up');
    const row = await runtime(appId);
    assert.equal(row.state, 'unhealthy');
    assert.match(row.last_error, /health check/i);
    assert.ok(!eng.events.includes('stop live-1'), 'an unhealthy app is shown, never stopped or restarted automatically');
  });

  test('a start that fails (for example the port is taken) is recorded and keeps the previous state', async () => {
    const appId = await makeApp();
    await store.setRuntime(appId, { state: 'stopped', action: 'stop', error: null });
    const eng = fakeEngine({ previous: ['live-1'], failOn: { 'start live-1': new Error('Bind for 0.0.0.0:9100 failed: port is already allocated') } });
    const r = await go(appId, 'start', eng);
    assert.equal(r.ok, false);
    const row = await runtime(appId);
    assert.equal(row.state, 'stopped');
    assert.match(row.last_error, /port is already allocated/);
    assert.equal(row.last_action, 'start');
  });
});

describe('forgiving earlier crashes', () => {
  const resetAt = async (appId) => (await pool.query('SELECT crash_reset_at, health_failures, next_restart_at FROM app_runtime WHERE app_id = $1', [appId])).rows[0];
  const dirty = async (appId) => pool.query(
    `INSERT INTO app_runtime (app_id, state, health_failures, next_restart_at) VALUES ($1, 'crashed', 7, now() + interval '1 minute')
     ON CONFLICT (app_id) DO UPDATE SET health_failures = 7, next_restart_at = now() + interval '1 minute'`, [appId]);

  for (const action of ['start', 'restart']) {
    test(`a manual ${action} starts counting crashes from zero`, async () => {
      const appId = await makeApp();
      await dirty(appId);
      await go(appId, action, fakeEngine({ previous: ['live-1'] }));
      const r = await resetAt(appId);
      assert.ok(r.crash_reset_at, 'the window restarts now');
      assert.deepEqual([r.health_failures, r.next_restart_at], [0, null]);
    });
  }

  test('also when the app starts but is unhealthy: the administrator did try again', async () => {
    const appId = await makeApp();
    await dirty(appId);
    await go(appId, 'start', fakeEngine({ previous: ['live-1'], health: { live: async () => { throw new Error('nope'); } } }));
    assert.ok((await resetAt(appId)).crash_reset_at);
  });

  test('a stop does not, and neither does a start that failed', async () => {
    const appId = await makeApp();
    await dirty(appId);
    await go(appId, 'stop', fakeEngine({ previous: ['live-1'] }));
    assert.equal((await resetAt(appId)).crash_reset_at, null);
    await go(appId, 'start', fakeEngine({ previous: ['live-1'], failOn: { 'start live-1': new Error('port in use') } }));
    assert.equal((await resetAt(appId)).crash_reset_at, null);
  });
});

describe('restart', () => {
  test('restarts the container without rebuilding anything, then waits for health', async () => {
    const appId = await makeApp();
    const eng = fakeEngine({ previous: ['live-1'] });
    const r = await go(appId, 'restart', eng);
    assert.equal(r.ok, true);
    assert.deepEqual(eng.events, ['restart live-1', 'health live-1']);
    assert.ok(!eng.runs.some((x) => x.cmd === 'docker' || x.cmd === 'git'), 'no clone, no build');
    assert.equal((await runtime(appId)).state, 'running');
  });
});

describe('when there is nothing to act on', () => {
  test('no container: says to deploy first, and does not invent a running state', async () => {
    const appId = await makeApp();
    const eng = fakeEngine({ previous: [] });
    const r = await go(appId, 'start', eng);
    assert.equal(r.ok, false);
    const row = await runtime(appId);
    assert.match(row.last_error, /deploy/i);
    assert.equal(row.state, 'stopped');
  });

  test('an app that no longer exists is skipped quietly', async () => {
    const eng = fakeEngine({ previous: ['live-1'] });
    const r = await go('00000000-0000-0000-0000-000000000000', 'stop', eng);
    assert.deepEqual([r.ok, r.skipped], [true, true]);
    assert.deepEqual(eng.events, []);
  });
});

describe('what gets stored', () => {
  test('a long error message is cut to a sane length', async () => {
    const appId = await makeApp();
    const eng = fakeEngine({ previous: ['live-1'], failOn: { 'start live-1': new Error('x'.repeat(5000)) } });
    await go(appId, 'start', eng);
    assert.ok((await runtime(appId)).last_error.length <= 500);
  });

  test('a successful action clears the previous error', async () => {
    const appId = await makeApp();
    await store.setRuntime(appId, { state: 'stopped', action: 'start', error: 'old failure' });
    await go(appId, 'stop', fakeEngine({ previous: ['live-1'] }));
    assert.equal((await runtime(appId)).last_error, null);
  });
});

describe('the job wrapper', () => {
  const job = (data) => ({ id: '9', data, log: async () => {} });

  test('refuses unknown actions and malformed ids before touching Docker', async () => {
    const eng = fakeEngine({ previous: ['live-1'] });
    await assert.rejects(processControlJob(job({ appId: '00000000-0000-0000-0000-000000000000', action: 'delete' }), { eng, db: store }), /action/i);
    await assert.rejects(processControlJob(job({ appId: 'not-a-uuid', action: 'stop' }), { eng, db: store }), /app/i);
    await assert.rejects(processControlJob(job({ action: 'stop' }), { eng, db: store }), /app/i);
    assert.deepEqual(eng.events, []);
  });

  test('fails the job when the action failed, so the queue shows it', async () => {
    const appId = await makeApp();
    const eng = fakeEngine({ previous: [] });
    await assert.rejects(processControlJob(job({ appId, action: 'start' }), { eng, db: store }), /deploy/i);
  });

  test('returns normally when the action worked', async () => {
    const appId = await makeApp();
    const eng = fakeEngine({ previous: ['live-1'] });
    const out = await processControlJob(job({ appId, action: 'stop' }), { eng, db: store });
    assert.deepEqual(out, { appId, action: 'stop' });
  });
});
