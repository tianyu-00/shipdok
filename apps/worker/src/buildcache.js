// Docker's build cache. Every build leaves layers behind in a cache that all apps share, so it has no owner and image clean-up never
// touches it; on a small disk it grows without end. This cleans it on request and measures it now and then.
//
// Cleaning runs as a job on the same queue as deployments (one at a time), so it never meets a build. Docker itself never removes
// cache a running build holds. It touches nothing but build cache: no images, containers, volumes or logs.
import * as realEngine from './docker.js';
import * as store from './db.js';

export const UNUSED_FOR_HOURS = 24; // "clean unused cache" keeps what a build used in the last day, so a recent app still builds fast

/**
 * @param {{all?: boolean}} job  all: remove every unused entry (the next builds start from nothing); otherwise only those unused for a day
 * @returns {Promise<{ok: true, freedBytes: number}>} Throws (after recording why) when Docker refuses.
 */
export async function cleanBuildCache({ all = false } = {}, { eng = realEngine, db = store, log = console.log } = {}) {
  let freedBytes;
  try {
    ({ freedBytes } = await eng.pruneBuildCache({ olderThanHours: all ? null : UNUSED_FOR_HOURS }));
  } catch (err) {
    await db.recordCacheClean({ all, freedBytes: 0, error: String(err.message ?? err) }).catch(() => {});
    throw err;
  }
  await db.recordCacheClean({ all, freedBytes });
  log(`Cleaned the build cache (${all ? 'everything unused' : `unused for ${UNUSED_FOR_HOURS} hours`}): about ${Math.round(freedBytes / 1048576)} MB freed`);
  await sampleBuildCache({ eng, db, log }).catch(() => {}); // the figures on the page should match what is left
  return { ok: true, freedBytes };
}

/** One look at the cache's size. A Docker that cannot report it is not an error: the page then shows no size. */
export async function sampleBuildCache({ eng = realEngine, db = store, log = console.log } = {}) {
  const usage = await eng.buildCacheUsage();
  if (!usage) return false;
  await db.recordCacheSample(usage);
  return true;
}

/** The BullMQ job 'cleancache' ({all}). */
export async function processCleanCacheJob(job, deps = {}) {
  const log = (msg) => {
    console.log(`[job ${job.id}] ${msg}`);
    Promise.resolve(job.log?.(msg)).catch(() => {});
  };
  return cleanBuildCache({ all: job.data?.all === true }, { ...deps, log });
}

/** Measures the cache every few minutes (Docker takes a few seconds to add it up, so not as often as CPU and memory). */
export function createCacheSampler({ db = store, eng = realEngine, intervalMs = 5 * 60_000, log = console.log } = {}) {
  let timer = null;
  let running = null;
  let stopping = false;
  let wake = null;
  const wait = (t) => new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, t); });
  return {
    tick: () => sampleBuildCache({ eng, db, log }),
    start() {
      if (running) return;
      stopping = false;
      running = (async () => {
        while (!stopping) {
          try { await sampleBuildCache({ eng, db, log }); } catch (err) { log(`build cache: ${err.message}`); }
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
