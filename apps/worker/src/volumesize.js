// How big the persistent volumes are. Docker adds a volume up by walking every file, which takes seconds (more on a Raspberry Pi's SD card), so nothing
// measures them by itself: the administrator asks on the Storage page and the API records the request. This notices the request and answers it with one look
// at every volume. It runs beside the deployment queue, not in it, so a slow measurement never holds a deployment up.
import * as realEngine from './docker.js';
import * as store from './db.js';

/** One look at every volume. Never throws: how it went is recorded, so the page can say. */
export async function measureVolumes({ eng = realEngine, db = store, log = console.log } = {}) {
  try {
    const sizes = await eng.volumeSizes();
    await db.recordVolumeSizes(sizes);
    await db.recordVolumeMeasured();
    log(`Measured the persistent volumes (${sizes.size} known to Docker)`);
    return { ok: true, volumes: sizes.size };
  } catch (err) {
    log(`Measuring the persistent volumes failed: ${err.message}`);
    await db.recordVolumeMeasured({ error: 'Docker could not measure the volumes' }).catch(() => {});
    return { ok: false };
  }
}

/** Looks for a request every few seconds (one cheap query) and answers it. */
export function createVolumeMeasurer({ db = store, eng = realEngine, intervalMs = 3000, log = console.log } = {}) {
  let timer = null;
  let running = null;
  let stopping = false;
  let wake = null;
  const wait = (t) => new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, t); });
  const tick = async () => {
    if (!(await db.volumeMeasureRequested())) return false;
    await measureVolumes({ eng, db, log });
    return true;
  };
  return {
    tick,
    start() {
      if (running) return;
      stopping = false;
      running = (async () => {
        while (!stopping) {
          try { await tick(); } catch (err) { log(`volume sizes: ${err.message}`); }
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
