// Samples the CPU and memory of every running app, now and then, and keeps the last hour. Read-only: it only asks Docker what a
// container is using. One app's trouble (a container that vanished, a slow Docker) never stops the others, and a reading that
// fails is simply missing: the dashboard shows gaps, not invented numbers.
import * as realEngine from './docker.js';
import * as store from './db.js';

export const KEEP_MS = 60 * 60 * 1000;

export function createSampler({ db = store, eng = realEngine, intervalMs = 15_000, keepMs = KEEP_MS, log = console.log }) {
  async function sampleApp(app) {
    const [container] = await eng.findContainers({ appId: app.id, role: 'live' });
    if (!container) return false; // nothing deployed yet
    if (!(await eng.isRunning(container))) return false;
    await db.insertStat(app.id, await eng.containerStats(container));
    return true;
  }

  async function tick() {
    const apps = await db.listSampleTargets();
    // Docker takes about a second per reading, so ask for all of them at once instead of one after the other.
    const results = await Promise.allSettled(apps.map((app) => sampleApp(app)));
    results.forEach((r, i) => { if (r.status === 'rejected') log(`stats: ${apps[i].slug}: ${r.reason?.message ?? r.reason}`); });
    await db.deleteOldStats(keepMs);
  }

  let timer = null;
  let running = null;
  let stopping = false;
  let wake = null;
  const wait = (t) => new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, t); });

  return {
    tick,
    start() {
      if (running) return;
      stopping = false;
      running = (async () => {
        while (!stopping) {
          try { await tick(); } catch (err) { log(`stats: ${err.message}`); }
          if (!stopping) await wait(intervalMs);
        }
      })();
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      wake?.();
      await running;
      running = null;
    },
  };
}
