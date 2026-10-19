// Keeps what actually happens to the apps in line with what the administrator wants: notices crashes, restarts them
// within the app's limit, reports health, and recovers apps after a host or Docker restart. The rules live in
// supervisor.js (pure); this gathers the facts, carries a decision out, and records it.
import * as realEngine from './docker.js';
import * as store from './db.js';
import { decide, CRASH_WINDOW_MS } from './supervisor.js';

const message = (err) => String(err?.message ?? err);

export function createMonitor({ db = store, eng = realEngine, activity, now = Date.now, intervalMs = 15_000, log = console.log }) {
  async function checkApp(app) {
    if (activity.isBusy(app.id)) return;
    const [container] = await eng.findContainers({ appId: app.id, role: 'live' });
    if (!container) return; // nothing deployed yet

    const facts = await eng.containerFacts(container);
    // Containers from before the monitor still carry Docker's own restart policy; Docker and the monitor must not both restart.
    if (facts.restartPolicy !== 'no') await eng.setRestartPolicyNone(container).catch((e) => log(`monitor: ${app.slug}: could not switch the restart policy: ${message(e)}`));

    const wantsRunning = app.desired === 'running';
    const exited = facts.status === 'exited' || facts.status === 'dead';
    const rt = app.runtime;
    const isNewExit = exited && wantsRunning && !(rt?.lastDeathAt != null && facts.finishedAt != null && facts.finishedAt <= rt.lastDeathAt);

    // Only gather what the decision will need.
    const healthOk = facts.status === 'running' && wantsRunning && app.healthPath
      ? await eng.probeHealth(container, { containerPort: app.containerPort, health: app.healthPath })
      : null;
    const death = isNewExit ? await eng.deathCause(container, facts.finishedAt ?? now()) : null;
    const crashesInWindow = isNewExit && death === 'crash' ? await db.countRecentCrashes(app.id, now() - CRASH_WINDOW_MS) : 0;

    // A job may have started while we were asking Docker; if so, the facts above may be stale. Leave it to the job.
    if (activity.isBusy(app.id)) return;

    const d = decide({
      now: now(), desired: app.desired, busy: false, container: facts, death, runtime: rt, crashesInWindow,
      maxRestarts: app.maxRestarts, healthOk,
    });
    if (d.type === 'skip') return;

    if (d.startNow) {
      try {
        await eng.startContainer(container);
      } catch (err) {
        // Do not retry a start that fails every tick: show it, and let the administrator decide.
        d.state = 'crashed';
        d.error = `Could not start it: ${message(err)}`;
        d.nextRestartAt = null;
        d.action = null;
        log(`monitor: ${app.slug}: ${d.error}`);
      }
    }

    const changed = !rt || d.state !== rt.state || d.error !== (rt.error ?? null) || d.healthFailures !== rt.healthFailures
      || d.nextRestartAt !== rt.nextRestartAt || d.event || d.death || d.action;
    if (!changed) return;
    await db.applyMonitorUpdate(app.id, d, now());
    if (d.event) log(`monitor: ${app.slug}: ${d.event.cause} (${d.event.action}); now ${d.state}`);
    else if (!rt || d.state !== rt.state) log(`monitor: ${app.slug}: ${rt?.state ?? 'unknown'} -> ${d.state}`);
  }

  async function tick() {
    for (const app of await db.listSupervised()) {
      try {
        await checkApp(app);
      } catch (err) {
        log(`monitor: ${app.slug}: ${message(err)}`); // one app's trouble never stops the others
      }
    }
  }

  let timer = null;
  let wake = null;
  let running = null;
  let stopping = false;
  const wait = (t) => new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, t); });

  return {
    tick,
    start() {
      if (running) return;
      stopping = false;
      running = (async () => {
        while (!stopping) {
          try { await tick(); } catch (err) { log(`monitor: ${message(err)}`); }
          if (!stopping) await wait(intervalMs);
        }
      })();
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      wake?.(); // the loop may be sitting in its wait
      await running;
      running = null;
    },
  };
}
