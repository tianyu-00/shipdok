// The monitor's decisions, with no Docker and no database: given what Docker shows and what we recorded, what now?
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide, restartDelayMs, CRASH_WINDOW_MS, HEALTH_FAILURES_BEFORE_UNHEALTHY } from '../src/supervisor.js';

const T0 = 1_800_000_000_000;
const running = { status: 'running', exitCode: 0, oomKilled: false, finishedAt: null };
const exited = (over = {}) => ({ status: 'exited', exitCode: 1, oomKilled: false, finishedAt: T0 - 2000, ...over });
const input = (over = {}) => ({
  now: T0, desired: 'running', busy: false, container: running, death: null, runtime: null,
  crashesInWindow: 0, maxRestarts: 5, healthOk: null, ...over,
});
const rt = (over = {}) => ({ state: 'running', nextRestartAt: null, healthFailures: 0, lastDeathAt: null, ...over });

describe('leaving things alone', () => {
  test('an app with a job in progress is skipped: a deployment stops containers on purpose', () => {
    assert.equal(decide(input({ busy: true, container: exited(), death: 'crash' })).type, 'skip');
  });
  test('nothing deployed yet: nothing to supervise', () => {
    assert.equal(decide(input({ container: null })).type, 'skip');
  });
  test('a stop that has been requested but not carried out yet is not interfered with', () => {
    assert.equal(decide(input({ desired: 'stopped', container: running })).type, 'skip');
  });
  test('a container in a state we do not model (paused) is left alone', () => {
    assert.equal(decide(input({ container: { ...running, status: 'paused' } })).type, 'skip');
  });
});

describe('an app that is meant to be stopped', () => {
  test('is reported stopped and is never started or counted as a crash', () => {
    const d = decide(input({ desired: 'stopped', container: exited(), death: 'crash' }));
    assert.equal(d.type, 'update');
    assert.equal(d.state, 'stopped');
    assert.equal(d.startNow, false);
    assert.equal(d.event, null);
  });
});

describe('a running container', () => {
  test('without a health check is simply running', () => {
    const d = decide(input({ healthOk: null }));
    assert.deepEqual([d.state, d.healthFailures, d.startNow], ['running', 0, false]);
  });

  test('failures are counted; it only becomes unhealthy after several in a row', () => {
    assert.equal(HEALTH_FAILURES_BEFORE_UNHEALTHY, 3);
    const one = decide(input({ healthOk: false, runtime: rt({ healthFailures: 0 }) }));
    assert.deepEqual([one.state, one.healthFailures], ['running', 1]);
    const three = decide(input({ healthOk: false, runtime: rt({ healthFailures: 2 }) }));
    assert.deepEqual([three.state, three.healthFailures], ['unhealthy', 3]);
    assert.match(three.error, /3/);
  });

  test('an unhealthy app is never restarted or stopped by the monitor', () => {
    const d = decide(input({ healthOk: false, runtime: rt({ state: 'unhealthy', healthFailures: 9 }) }));
    assert.equal(d.state, 'unhealthy');
    assert.equal(d.startNow, false);
  });

  test('one good check clears the failures and the unhealthy state', () => {
    const d = decide(input({ healthOk: true, runtime: rt({ state: 'unhealthy', healthFailures: 5 }) }));
    assert.deepEqual([d.state, d.healthFailures, d.error], ['running', 0, null]);
  });

  test('after an automatic restart it is just running again, with no pending restart', () => {
    const d = decide(input({ runtime: rt({ state: 'restarting', nextRestartAt: T0 - 1 }) }));
    assert.deepEqual([d.state, d.nextRestartAt], ['running', null]);
  });

  test('a container Docker itself is restarting is shown as restarting', () => {
    assert.equal(decide(input({ container: { ...running, status: 'restarting' } })).state, 'restarting');
  });
});

describe('a new crash', () => {
  test('is recorded and a restart is scheduled after a short delay', () => {
    const d = decide(input({ container: exited({ exitCode: 1 }), death: 'crash', crashesInWindow: 0 }));
    assert.equal(d.state, 'restarting');
    assert.equal(d.startNow, false, 'the restart waits for its delay');
    assert.equal(d.nextRestartAt, T0 + 5000);
    assert.deepEqual(d.death, { at: T0 - 2000, exitCode: 1, oomKilled: false });
    assert.deepEqual(d.event, { cause: 'crash', exitCode: 1, oomKilled: false, action: 'restart_scheduled' });
    assert.match(d.error, /code 1/);
  });

  test('the delay grows with each crash and is capped', () => {
    assert.deepEqual([1, 2, 3, 4].map(restartDelayMs), [5000, 15000, 45000, 135000]);
    assert.equal(restartDelayMs(20), 5 * 60_000);
    assert.equal(decide(input({ container: exited(), death: 'crash', crashesInWindow: 2 })).nextRestartAt, T0 + 45000);
  });

  test('an out-of-memory kill is called out', () => {
    const d = decide(input({ container: exited({ exitCode: 137, oomKilled: true }), death: 'crash' }));
    assert.match(d.error, /out of memory/i);
    assert.equal(d.event.oomKilled, true);
  });

  test('the 5th restart is still allowed, the 6th crash in the window gives up', () => {
    assert.equal(decide(input({ container: exited(), death: 'crash', crashesInWindow: 4 })).state, 'restarting');
    const d = decide(input({ container: exited(), death: 'crash', crashesInWindow: 5 }));
    assert.equal(d.state, 'crashed');
    assert.equal(d.nextRestartAt, null);
    assert.equal(d.startNow, false);
    assert.equal(d.event.action, 'gave_up');
    assert.match(d.error, /not restarting/i);
  });

  test('the limit is per app: 0 means never restart automatically', () => {
    const d = decide(input({ container: exited(), death: 'crash', crashesInWindow: 0, maxRestarts: 0 }));
    assert.deepEqual([d.state, d.event.action], ['crashed', 'gave_up']);
    assert.equal(decide(input({ container: exited(), death: 'crash', crashesInWindow: 1, maxRestarts: 2 })).state, 'restarting');
    assert.equal(decide(input({ container: exited(), death: 'crash', crashesInWindow: 2, maxRestarts: 2 })).state, 'crashed');
  });

  test('the window is ten minutes', () => {
    assert.equal(CRASH_WINDOW_MS, 10 * 60_000);
  });
});

describe('an exit nobody can explain as a crash', () => {
  test('stopped from outside Shipdok (docker stop / kill): not restarted, shown as crashed, not counted', () => {
    const d = decide(input({ container: exited({ exitCode: 137 }), death: 'outside', crashesInWindow: 99 }));
    assert.deepEqual([d.state, d.startNow, d.nextRestartAt], ['crashed', false, null]);
    assert.deepEqual(d.event, { cause: 'stopped_outside', exitCode: 137, oomKilled: false, action: 'none' });
    assert.match(d.error, /outside Shipdok/i);
  });

  test('cause unknown (the host or Docker restarted): started again straight away, and it does not count against the limit', () => {
    const d = decide(input({ container: exited({ exitCode: 255 }), death: 'unknown', crashesInWindow: 99 }));
    assert.deepEqual([d.state, d.startNow, d.action], ['running', true, 'recover']);
    assert.equal(d.event.cause, 'recovered');
    assert.equal(d.event.action, 'restarted');
  });

  test('a container that was created but never started is just started', () => {
    const d = decide(input({ container: { status: 'created', exitCode: 0, oomKilled: false, finishedAt: null } }));
    assert.deepEqual([d.startNow, d.action, d.event], [true, 'recover', null]);
  });
});

describe('waiting for a scheduled restart (the exit was already recorded)', () => {
  const recorded = (over = {}) => rt({ state: 'restarting', nextRestartAt: T0 + 10_000, lastDeathAt: T0 - 2000, ...over });

  test('the same exit is never counted twice', () => {
    const d = decide(input({ container: exited(), death: null, runtime: recorded() }));
    assert.equal(d.type, 'skip');
  });

  test('when the delay has passed, start it', () => {
    const d = decide(input({ now: T0 + 10_000, container: exited(), runtime: recorded() }));
    assert.deepEqual([d.startNow, d.action, d.state, d.nextRestartAt], [true, 'auto_restart', 'running', null]);
    assert.equal(d.event, null, 'the restart was already scheduled when the crash was recorded');
  });

  test('a restart state with no due time is treated as due', () => {
    const d = decide(input({ container: exited(), runtime: recorded({ nextRestartAt: null }) }));
    assert.equal(d.startNow, true);
  });

  test('a crashed app stays down until someone starts it', () => {
    const d = decide(input({ now: T0 + 3_600_000, container: exited(), runtime: recorded({ state: 'crashed', nextRestartAt: null }) }));
    assert.equal(d.type, 'skip');
  });

  test('a newer exit than the one recorded is a new crash', () => {
    const d = decide(input({ container: exited({ finishedAt: T0 - 500 }), death: 'crash', runtime: recorded({ lastDeathAt: T0 - 60_000 }) }));
    assert.equal(d.event.cause, 'crash');
  });
});

describe('a container that cannot be started', () => {
  test('a created container whose start already failed (state crashed) is left alone, not retried every tick', () => {
    const created = { status: 'created', exitCode: 0, oomKilled: false, finishedAt: null };
    assert.equal(decide(input({ container: created, runtime: rt({ state: 'crashed' }) })).type, 'skip');
    assert.equal(decide(input({ container: created, runtime: rt({ state: 'stopped' }) })).startNow, true);
  });
});
