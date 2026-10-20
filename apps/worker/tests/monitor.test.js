// The monitor loop against a fake Docker and the real test database: the decisions (supervisor.test.js) carried out,
// recorded once, and kept consistent across ticks.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/db.js';
import { createMonitor } from '../src/monitor.js';
import { createActivity } from '../src/activity.js';
import { CRASH_WINDOW_MS } from '../src/supervisor.js';
import { pool, ready, reset, makeApp, makeDeployment } from './helpers.js';
import { fakeEngine } from './fake-engine.js';

before(ready);
beforeEach(reset);
after(() => pool.end());

// The fake clock starts at the real time: some rules compare it with timestamps the database sets itself (now()).
let clock;
const advance = (ms) => { clock += ms; };
beforeEach(() => { clock = Date.now(); });

const setup = async (cfg = {}, { appOver = {} } = {}) => {
  const appId = await makeApp();
  await pool.query(`UPDATE apps SET health_path = '/health' WHERE id = $1`, [appId]);
  for (const [col, val] of Object.entries(appOver)) await pool.query(`UPDATE apps SET ${col} = $2 WHERE id = $1`, [appId, val]);
  const eng = fakeEngine({ previous: ['live-1'], ...cfg });
  const activity = createActivity();
  const monitor = createMonitor({ db: store, eng, activity, now: () => clock, log: () => {} });
  return { appId, eng, activity, monitor };
};
const rt = async (appId) => (await pool.query('SELECT * FROM app_runtime WHERE app_id = $1', [appId])).rows[0];
const events = async (appId) => (await pool.query('SELECT * FROM app_crash_events WHERE app_id = $1 ORDER BY id', [appId])).rows;
const crashed = (eng, over = {}) => { eng.facts = { ...eng.facts, status: 'exited', exitCode: 1, finishedAt: clock - 1000, ...over }; };
const runningAgain = (eng) => { eng.facts = { ...eng.facts, status: 'running', exitCode: 0, finishedAt: null }; };

describe('a healthy app', () => {
  test('is recorded as running, with its health checked using the app\'s own settings', async () => {
    const { appId, monitor, eng } = await setup();
    await monitor.tick();
    assert.equal((await rt(appId)).state, 'running');
    assert.deepEqual([eng.lastProbe.containerPort, eng.lastProbe.health], [3000, '/health']);
  });

  test('nothing is written when nothing has changed (the Pi\'s SD card says thanks)', async () => {
    const { appId, monitor } = await setup();
    await monitor.tick();
    const first = (await rt(appId)).updated_at;
    await new Promise((r) => setTimeout(r, 15));
    await monitor.tick();
    assert.deepEqual((await rt(appId)).updated_at, first);
  });

  test('the Docker event log is only consulted for a NEW exit, never for healthy apps or an exit already recorded', async () => {
    const { monitor, eng } = await setup();
    await monitor.tick(); await monitor.tick();
    assert.ok(!eng.events.some((e) => e.startsWith('cause')), 'healthy: no lookup');
    crashed(eng);
    await monitor.tick();
    assert.equal(eng.events.filter((e) => e.startsWith('cause')).length, 1);
    await monitor.tick(); await monitor.tick();
    assert.equal(eng.events.filter((e) => e.startsWith('cause')).length, 1, 'the same exit is not looked up again');
  });

  test('no health check configured: it is running, and no probe is made', async () => {
    const { appId, monitor, eng } = await setup({}, { appOver: { health_path: null } });
    await monitor.tick();
    assert.equal((await rt(appId)).state, 'running');
    assert.ok(!eng.events.some((e) => e.startsWith('probe')));
  });

  test('Docker\'s old restart policy is switched off once', async () => {
    const { monitor, eng } = await setup({ facts: { restartPolicy: 'on-failure' } });
    await monitor.tick();
    await monitor.tick();
    assert.equal(eng.events.filter((e) => e.startsWith('policy')).length, 1);
  });
});

describe('health', () => {
  test('three failed checks in a row make it unhealthy; it is left running; one good check clears it', async () => {
    const { appId, monitor, eng } = await setup({ probe: false });
    await monitor.tick(); await monitor.tick();
    assert.deepEqual([(await rt(appId)).state, (await rt(appId)).health_failures], ['running', 2]);
    await monitor.tick();
    assert.deepEqual([(await rt(appId)).state, (await rt(appId)).health_failures], ['unhealthy', 3]);
    assert.match((await rt(appId)).last_error, /health check/i);
    assert.ok(!eng.events.some((e) => e.startsWith('start') || e.startsWith('stop')), 'never restarted or stopped');
    eng.probe = true;
    await monitor.tick();
    assert.deepEqual([(await rt(appId)).state, (await rt(appId)).health_failures, (await rt(appId)).last_error], ['running', 0, null]);
  });
});

describe('a crash', () => {
  test('is recorded once, shown as restarting, and restarted when its delay has passed', async () => {
    const { appId, monitor, eng } = await setup();
    await monitor.tick();
    crashed(eng, { exitCode: 1 });
    await monitor.tick();
    let r = await rt(appId);
    assert.deepEqual([r.state, r.last_exit_code], ['restarting', 1]);
    assert.equal(new Date(r.next_restart_at).getTime(), clock + 5000);
    assert.ok(!eng.events.includes('start live-1'), 'not yet: the delay has not passed');
    assert.deepEqual((await events(appId)).map((e) => [e.cause, e.action, e.exit_code]), [['crash', 'restart_scheduled', 1]]);

    await monitor.tick(); await monitor.tick(); // the same exit seen again: still one event, still waiting
    assert.equal((await events(appId)).length, 1);

    advance(5000);
    await monitor.tick();
    assert.ok(eng.events.includes('start live-1'));
    r = await rt(appId);
    assert.deepEqual([r.state, r.last_action, r.next_restart_at], ['running', 'auto_restart', null]);
  });

  test('an out-of-memory kill is recorded as such', async () => {
    const { appId, monitor, eng } = await setup();
    crashed(eng, { exitCode: 137, oomKilled: true });
    await monitor.tick();
    assert.equal((await rt(appId)).oom_killed, true);
    assert.match((await rt(appId)).last_error, /out of memory/i);
    assert.equal((await events(appId))[0].oom_killed, true);
  });

  test('five restarts are allowed; the sixth crash in ten minutes gives up and it stays down', async () => {
    const { appId, monitor, eng } = await setup();
    for (let i = 1; i <= 5; i++) {
      crashed(eng, { finishedAt: clock - 500 });
      await monitor.tick();
      assert.equal((await rt(appId)).state, 'restarting', `crash ${i}`);
      clock = new Date((await rt(appId)).next_restart_at).getTime(); // wait out the real backoff (5 s, 15 s, 45 s, ...)
      await monitor.tick();
      assert.equal(eng.events.filter((e) => e === 'start live-1').length, i, `restart ${i}`);
      runningAgain(eng);
      await monitor.tick();
    }
    crashed(eng, { finishedAt: clock - 500 });
    await monitor.tick();
    const r = await rt(appId);
    assert.equal(r.state, 'crashed');
    assert.match(r.last_error, /not restarting/i);
    assert.equal((await events(appId)).at(-1).action, 'gave_up');
    const starts = eng.events.filter((e) => e === 'start live-1').length;
    advance(60 * 60_000);
    await monitor.tick(); await monitor.tick();
    assert.equal(eng.events.filter((e) => e === 'start live-1').length, starts, 'a crashed app is left alone');
    assert.equal((await events(appId)).length, 6, 'and the same exit is not counted again');
  });

  test('the app\'s own limit applies: 0 means the first crash is the last', async () => {
    const { appId, monitor, eng } = await setup({}, { appOver: { max_restarts: 0 } });
    crashed(eng);
    await monitor.tick();
    assert.equal((await rt(appId)).state, 'crashed');
    assert.ok(!eng.events.includes('start live-1'));
  });

  test('crashes older than the window do not count', async () => {
    const { appId, monitor, eng } = await setup();
    for (let i = 0; i < 5; i++) {
      await pool.query(`INSERT INTO app_crash_events (app_id, occurred_at, cause, action) VALUES ($1, $2, 'crash', 'restart_scheduled')`,
        [appId, new Date(clock - CRASH_WINDOW_MS - 60_000)]);
    }
    crashed(eng);
    await monitor.tick();
    assert.equal((await rt(appId)).state, 'restarting');
  });

  test('outside stops and reboot recoveries do not use up the restart allowance', async () => {
    const { appId, monitor, eng } = await setup();
    for (const cause of ['stopped_outside', 'stopped_outside', 'recovered', 'recovered', 'recovered', 'recovered']) {
      await pool.query(`INSERT INTO app_crash_events (app_id, occurred_at, cause, action) VALUES ($1, $2, $3, 'none')`, [appId, new Date(clock - 1000), cause]);
    }
    crashed(eng);
    await monitor.tick();
    assert.equal((await rt(appId)).state, 'restarting', 'only real crashes count');
  });

  test('a manual start forgives earlier crashes', async () => {
    const { appId, monitor, eng } = await setup();
    for (let i = 0; i < 5; i++) {
      await pool.query(`INSERT INTO app_crash_events (app_id, occurred_at, cause, action) VALUES ($1, $2, 'crash', 'restart_scheduled')`, [appId, new Date(clock - 1000)]);
    }
    await store.setRuntime(appId, { state: 'running', action: 'start', error: null, resetCrashes: true });
    crashed(eng);
    await monitor.tick();
    assert.equal((await rt(appId)).state, 'restarting', 'counted from zero after the manual start');
  });

  test('if starting it again fails, it is marked crashed and not retried every tick', async () => {
    const { appId, monitor, eng } = await setup({ failOn: { 'start live-1': new Error('port is already allocated') } });
    crashed(eng);
    await monitor.tick();
    advance(5000);
    await monitor.tick();
    const r = await rt(appId);
    assert.equal(r.state, 'crashed');
    assert.match(r.last_error, /port is already allocated/);
    const startsBefore = eng.events.filter((e) => e === 'start live-1').length;
    await monitor.tick(); await monitor.tick();
    assert.equal((await rt(appId)).state, 'crashed');
    assert.equal(eng.events.filter((e) => e === 'start live-1').length, startsBefore, 'no more attempts');
  });
});

describe('an exit that was not a crash', () => {
  test('stopped from outside (docker stop): not restarted, shown as crashed, history says why', async () => {
    const { appId, monitor, eng } = await setup({ cause: 'outside' });
    crashed(eng, { exitCode: 137 });
    await monitor.tick();
    assert.ok(!eng.events.includes('start live-1'));
    const r = await rt(appId);
    assert.equal(r.state, 'crashed');
    assert.match(r.last_error, /outside Shipdok/i);
    assert.deepEqual((await events(appId)).map((e) => [e.cause, e.action]), [['stopped_outside', 'none']]);
    await monitor.tick(); await monitor.tick();
    assert.equal((await events(appId)).length, 1);
  });

  test('after a host or Docker restart (cause unknown) the app is started again straight away and it does not count', async () => {
    const { appId, monitor, eng } = await setup({ cause: 'unknown' });
    for (let i = 0; i < 9; i++) {
      await pool.query(`INSERT INTO app_crash_events (app_id, cause, action) VALUES ($1, 'crash', 'restart_scheduled')`, [appId]);
    }
    crashed(eng, { exitCode: 255 });
    await monitor.tick();
    assert.ok(eng.events.includes('start live-1'));
    const r = await rt(appId);
    assert.deepEqual([r.state, r.last_action], ['running', 'recover']);
    assert.equal((await events(appId)).at(-1).cause, 'recovered');
  });

  test('a container that was created but never started is just started', async () => {
    const { appId, monitor, eng } = await setup();
    eng.facts = { ...eng.facts, status: 'created', finishedAt: null };
    await monitor.tick();
    assert.ok(eng.events.includes('start live-1'));
    assert.equal((await events(appId)).length, 0);
  });
});

describe('what the monitor must not touch', () => {
  test('an app the administrator stopped stays stopped, and is reported so', async () => {
    const { appId, monitor, eng } = await setup();
    await pool.query(`UPDATE apps SET desired_state = 'stopped' WHERE id = $1`, [appId]);
    crashed(eng, { exitCode: 143 });
    await monitor.tick();
    assert.equal((await rt(appId)).state, 'stopped');
    assert.ok(!eng.events.includes('start live-1'));
    assert.equal((await events(appId)).length, 0);
  });

  test('a stop that has been requested but not carried out is not interfered with', async () => {
    const { appId, monitor, eng } = await setup();
    await pool.query(`UPDATE apps SET desired_state = 'stopped' WHERE id = $1`, [appId]);
    await monitor.tick(); // container still running
    assert.equal(await rt(appId), undefined);
    assert.ok(!eng.events.some((e) => e.startsWith('stop') || e.startsWith('probe')));
  });

  test('an app a deployment or control job is working on is skipped entirely', async () => {
    const { appId, monitor, eng, activity } = await setup();
    crashed(eng);
    await activity.run(appId, () => monitor.tick());
    assert.equal(await rt(appId), undefined);
    assert.equal((await events(appId)).length, 0);
    assert.ok(!eng.events.some((e) => e.startsWith('cause')));
  });

  test('an app with nothing deployed is ignored', async () => {
    const { appId, monitor } = await setup({ previous: [] });
    await monitor.tick();
    assert.equal(await rt(appId), undefined);
  });

  test('one app failing does not stop the others from being checked', async () => {
    const a = await makeApp();
    const b = await makeApp();
    const eng = fakeEngine({ previous: ['live-1'] });
    const original = eng.findContainers;
    eng.findContainers = async (f) => { if (f.appId === a) throw new Error('docker hiccup'); return original(f); };
    const monitor = createMonitor({ db: store, eng, activity: createActivity(), now: () => clock, log: () => {} });
    await monitor.tick();
    assert.equal(await rt(a), undefined);
    assert.equal((await rt(b)).state, 'running');
  });
});

describe('collecting the app\'s own output', () => {
  const withCollector = async (cfg = {}, over = {}) => {
    const t = await setup(cfg, over);
    const seen = [];
    const collector = { sync: async (app, container, facts) => { seen.push([app.id, facts.status]); t.eng.events.push('collector.sync'); } };
    const monitor = createMonitor({ db: store, eng: t.eng, activity: t.activity, collector, now: () => clock, log: () => {} });
    return { ...t, seen, monitor };
  };

  test('every container the monitor looks at is passed to the collector, running or not', async () => {
    const t = await withCollector();
    await t.monitor.tick();
    crashed(t.eng);
    await t.monitor.tick();
    assert.deepEqual(t.seen, [[t.appId, 'running'], [t.appId, 'exited']]);
  });

  test('a stopped app\'s container is passed on too (its last output must still be saved)', async () => {
    const t = await withCollector();
    await pool.query(`UPDATE apps SET desired_state = 'stopped' WHERE id = $1`, [t.appId]);
    crashed(t.eng, { exitCode: 143 });
    await t.monitor.tick();
    assert.equal(t.seen.length, 1);
  });

  test('an app a deployment or control job is working on is left to that job', async () => {
    const t = await withCollector();
    await t.activity.run(t.appId, () => t.monitor.tick());
    assert.deepEqual(t.seen, []);
  });

  test('the output is looked at BEFORE a crashed container is started again, so the run that died is closed first', async () => {
    const t = await withCollector();
    crashed(t.eng);
    await t.monitor.tick();
    advance(5000);
    await t.monitor.tick();
    const events = t.eng.events;
    assert.ok(events.indexOf('collector.sync') < events.indexOf('start live-1'));
  });

  test('a collector that fails cannot stop crash handling', async () => {
    const t = await setup();
    const logged = [];
    const collector = { sync: async () => { throw new Error('disk full'); } };
    const monitor = createMonitor({ db: store, eng: t.eng, activity: t.activity, collector, now: () => clock, log: (m) => logged.push(m) });
    crashed(t.eng);
    await monitor.tick();
    assert.equal((await rt(t.appId)).state, 'restarting');
    assert.ok(logged.some((m) => /disk full/.test(m)));
  });

  test('no collector at all is fine', async () => {
    const t = await setup();
    await t.monitor.tick();
    assert.equal((await rt(t.appId)).state, 'running');
  });
});

describe('the loop', () => {
  test('ticks repeatedly until stopped', async () => {
    const { appId, eng } = await setup();
    const monitor = createMonitor({ db: store, eng, activity: createActivity(), now: () => clock, intervalMs: 20, log: () => {} });
    monitor.start();
    await new Promise((r) => setTimeout(r, 150));
    await monitor.stop();
    const probes = eng.events.filter((e) => e.startsWith('probe')).length;
    assert.ok(probes >= 3, `only ${probes} checks in 150 ms`);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(eng.events.filter((e) => e.startsWith('probe')).length, probes, 'nothing runs after stop()');
    assert.equal((await rt(appId)).state, 'running');
  });
});

describe('a container removed outside Shipdok', () => {
  const deployed = async (appId) => {
    const id = await makeDeployment(appId, { container_port: 3000 });
    await pool.query("UPDATE deployments SET status = 'successful', finished_at = now() WHERE id = $1", [id]);
  };

  test('a deployed app whose container is gone is recorded as missing, once, however many checks follow', async () => {
    const { appId, monitor, eng } = await setup({ previous: [] });
    await deployed(appId);
    await monitor.tick(); await monitor.tick(); await monitor.tick();
    const r = await rt(appId);
    assert.equal(r.state, 'missing');
    assert.match(r.last_error, /removed outside Shipdok/);
    const ev = await events(appId);
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].cause, ev[0].action], ['removed_outside', 'none']);
    assert.ok(!eng.events.some((e) => e.startsWith('start')), 'it is not recreated or started');
  });

  test('an app that was never deployed stays unreported', async () => {
    const { appId, monitor } = await setup({ previous: [] });
    await monitor.tick();
    assert.equal(await rt(appId), undefined);
    assert.equal((await events(appId)).length, 0);
  });

  test('while a job works on the app nothing is recorded, even if the container list came back empty', async () => {
    const { appId, monitor, activity, eng } = await setup({ previous: [] });
    await deployed(appId);
    // A deployment starts while the monitor is asking Docker, and has just removed the old container.
    let release; let job;
    eng.findContainers = async () => { job = activity.run(appId, () => new Promise((r) => { release = r; })); return []; };
    await monitor.tick();
    release(); await job;
    assert.equal(await rt(appId), undefined);
  });

  test('an app being deleted is not reported as missing', async () => {
    const { appId, monitor } = await setup({ previous: [] });
    await deployed(appId);
    await pool.query('UPDATE apps SET deleting_at = now() WHERE id = $1', [appId]);
    await monitor.tick();
    assert.equal(await rt(appId), undefined);
  });

  test('when the container comes back it is running again, and a second removal is a second entry', async () => {
    const { appId, monitor, eng } = await setup({ previous: [] });
    await deployed(appId);
    await monitor.tick();
    assert.equal((await rt(appId)).state, 'missing');
    const live = eng.findContainers; // a container appears (a redeploy)
    eng.findContainers = async () => ['live-1'].map((name) => ({ name }));
    await monitor.tick();
    assert.equal((await rt(appId)).state, 'running');
    eng.findContainers = live;
    await monitor.tick();
    assert.equal((await rt(appId)).state, 'missing');
    assert.equal((await events(appId)).length, 2);
  });
});
