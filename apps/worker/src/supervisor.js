// What to do about one app, decided from what Docker shows and what we have already recorded. Pure: no Docker, no
// database, no clock of its own, so every rule can be tested exactly. The monitor (monitor.js) gathers the facts and
// carries the decision out.
//
// The rules (SPEC.md section 11):
//   - A crash is restarted after a growing delay, up to the app's limit within a window; then it is marked crashed
//     and stays down until the administrator starts it.
//   - An unhealthy app is shown and left running: never restarted or rolled back automatically.
//   - An app the administrator stopped is never started. A container stopped OUTSIDE Shipdok while the app should be
//     running (docker stop / docker kill) is not restarted either: it is shown as crashed so someone looks at it.
//   - After a host or Docker restart (the cause cannot be found) the app is simply started again, uncounted.

export const CRASH_WINDOW_MS = 10 * 60_000;
export const HEALTH_FAILURES_BEFORE_UNHEALTHY = 3;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_FACTOR = 3;
const BACKOFF_CAP_MS = 5 * 60_000;

/** Delay before restart number `n` (1 = the first restart after a crash): 5 s, 15 s, 45 s, ... capped at 5 minutes. */
export const restartDelayMs = (n) => Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** (n - 1), BACKOFF_CAP_MS);

const SKIP = { type: 'skip' };
const update = (u) => ({
  type: 'update', error: null, healthFailures: 0, nextRestartAt: null, startNow: false, action: null, event: null, death: null, ...u,
});

const exitText = (c) => `Exited with code ${c.exitCode}${c.oomKilled ? ' (out of memory)' : ''}`;

// There is no live container. For an app that never went live that is normal. For one that did, somebody removed the container outside
// Shipdok (docker rm): show it, once, and do not recreate it, in the same spirit as a stop from outside. A new deployment brings it back.
function decideGone(i) {
  if (!i.deployed || i.runtime?.state === 'missing') return SKIP;
  return update({
    state: 'missing',
    error: 'The container was removed outside Shipdok (for example with docker rm). Nothing is running. Deploy the app again to bring it back.',
    event: { cause: 'removed_outside', exitCode: null, oomKilled: false, action: 'none' },
  });
}

/**
 * @param {object} i
 * @param {number} i.now                                   ms since the epoch
 * @param {'running'|'stopped'} i.desired                  what the administrator wants
 * @param {boolean} i.busy                                 a deployment or control job for this app is in progress
 * @param {null | {status: string, exitCode: number, oomKilled: boolean, finishedAt: number|null}} i.container
 * @param {'crash'|'outside'|'unknown'|null} i.death       why a NEW exit happened (the caller only works it out when needed)
 * @param {null | {state: string, nextRestartAt: number|null, healthFailures: number, lastDeathAt: number|null}} i.runtime
 * @param {number} i.crashesInWindow                       crashes already recorded within the window (not counting this exit)
 * @param {number} i.maxRestarts
 * @param {boolean|null} i.healthOk                        null = no health check configured
 * @param {boolean} [i.deployed]                           a version of this app has been deployed successfully before
 */
export function decide(i) {
  if (i.busy) return SKIP;
  if (!i.container) return decideGone(i);
  const c = i.container;
  const rt = i.runtime ?? { state: null, nextRestartAt: null, healthFailures: 0, lastDeathAt: null };

  // An app that is meant to be stopped. A container still running means a stop is on its way: leave it to that job.
  if (i.desired === 'stopped') {
    if (c.status === 'running' || c.status === 'restarting') return SKIP;
    return update({ state: 'stopped' });
  }

  switch (c.status) {
    case 'running': {
      const failures = i.healthOk === false ? rt.healthFailures + 1 : 0;
      const unhealthy = failures >= HEALTH_FAILURES_BEFORE_UNHEALTHY;
      return update({
        state: unhealthy ? 'unhealthy' : 'running',
        healthFailures: failures,
        error: unhealthy ? `The health check failed ${failures} times in a row` : null,
      });
    }
    case 'restarting':
      return update({ state: 'restarting' });
    case 'created':
      // Never started (for example deployed while stopped, then wanted running). Not a crash. If starting it already
      // failed (state crashed) leave it for the administrator instead of retrying every tick.
      if (rt.state === 'crashed') return SKIP;
      return update({ state: 'running', startNow: true, action: 'recover' });
    case 'exited':
    case 'dead':
      break;
    default:
      return SKIP;
  }

  // The container has exited although it should be running.
  const isNew = !(rt.lastDeathAt != null && c.finishedAt != null && c.finishedAt <= rt.lastDeathAt);
  if (!isNew) {
    if (rt.state === 'restarting' && (rt.nextRestartAt == null || i.now >= rt.nextRestartAt)) {
      return update({ state: 'running', startNow: true, action: 'auto_restart' });
    }
    return SKIP; // waiting for the delay, or crashed and waiting for the administrator
  }

  const death = { at: c.finishedAt, exitCode: c.exitCode, oomKilled: c.oomKilled };
  const event = (cause, action) => ({ cause, exitCode: c.exitCode, oomKilled: c.oomKilled, action });

  if (i.death === 'outside') {
    return update({
      state: 'crashed', death, event: event('stopped_outside', 'none'),
      error: `Stopped outside Shipdok (for example with docker stop). It was not restarted: start it from Shipdok when you want it running`,
    });
  }
  if (i.death === 'unknown') {
    return update({ state: 'running', death, startNow: true, action: 'recover', event: event('recovered', 'restarted') });
  }

  const count = i.crashesInWindow + 1;
  if (count > i.maxRestarts) {
    return update({
      state: 'crashed', death, event: event('crash', 'gave_up'),
      error: `${exitText(c)}. It crashed ${count} times within ${CRASH_WINDOW_MS / 60_000} minutes, so it is not restarting automatically: start it when you have looked at the logs`,
    });
  }
  return update({
    state: 'restarting', death, error: exitText(c), nextRestartAt: i.now + restartDelayMs(count),
    event: event('crash', 'restart_scheduled'),
  });
}
