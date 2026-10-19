// Deleting an app, for good: its containers, every image Shipdok built for it, all its logs, and its records. The API only
// marks the app ("being deleted") and queues this job; the worker is the one that talks to Docker.
//
// Runs on the same queue as deployments (one at a time), so it can never meet a swap. Every step can be repeated, so a failed
// attempt is simply tried again: a failure is written to the app (delete_error) and the app stays, marked, for a retry.
// Order matters: the records go LAST, so as long as anything is left to remove the app is still there to retry from.
import * as realEngine from './docker.js';
import * as store from './db.js';
import { logRoot as defaultLogRoot, removeAppLogs } from '@shipdok/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_RE = /^shipdok\/[a-z0-9][a-z0-9-]{0,39}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @returns {Promise<{ok: true, skipped: true} | {ok: true, containers: number, images: number, logBytes: number}>}
 */
export async function deleteApp({ appId }, { eng = realEngine, db = store, collector = null, logRoot = defaultLogRoot(), log = console.log } = {}) {
  const app = await db.getAppForDelete(appId);
  if (!app) {
    log('Skipped: the app is already gone');
    return { ok: true, skipped: true };
  }
  if (!app.deleting_at) throw new Error('The app is not marked for deletion, so nothing was removed'); // never act on an unmarked app

  try {
    // 1. Stop following its output (the log files are about to go).
    await collector?.release(appId);

    // 2. Its containers: the live one, and any candidate a dead worker left. Stopped, then removed.
    const containers = await eng.findAppContainers(appId);
    for (const c of containers) {
      await eng.stopContainer(c).catch(() => {}); // a graceful stop first; removal below forces it if that failed
      await eng.removeContainerStrict(c);
    }
    log(`Removed ${containers.length} container(s) of ${app.slug}`);

    // 3. Its images. Only ones labelled as this app's own AND named the way Shipdok names them.
    let images = 0;
    let stuck = 0;
    for (const img of await eng.listAppImages(appId)) {
      if (!TAG_RE.test(img.tag)) continue;
      const outcome = await eng.removeImageStrict(img.tag);
      if (outcome === 'removed') { images += 1; log(`Removed image ${img.tag}`); }
      else if (outcome === 'in-use') stuck += 1;
    }
    if (stuck > 0) throw new Error(`${stuck} image(s) are still used by a container Shipdok did not make for this app`);

    // 4. Its logs: the runtime logs and every deployment's build log.
    const logBytes = await removeAppLogs(logRoot, appId);

    // 5. Its records.
    if (!(await db.deleteAppRows(appId))) throw new Error('The app was no longer marked for deletion');
    log(`Deleted ${app.slug}: ${containers.length} container(s), ${images} image(s), ${Math.round(logBytes / 1024)} KB of logs`);
    return { ok: true, containers: containers.length, images, logBytes };
  } catch (err) {
    const message = String(err.message ?? err);
    await db.setDeleteError(appId, message).catch(() => {});
    log(`Could not delete ${app.slug}: ${message}`);
    throw err;
  }
}

/** The BullMQ job 'deleteapp' ({appId}). */
export async function processDeleteJob(job, deps = {}) {
  const { appId } = job.data ?? {};
  if (typeof appId !== 'string' || !UUID_RE.test(appId)) throw new Error('Delete job is missing a valid app id');
  const log = (msg) => {
    console.log(`[job ${job.id}] ${msg}`);
    Promise.resolve(job.log?.(msg)).catch(() => {});
  };
  return deleteApp({ appId }, { ...deps, log });
}
