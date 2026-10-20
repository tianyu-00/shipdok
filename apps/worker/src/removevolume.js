// Deleting ONE volume and its data, on the administrator's explicit request (a detached volume, or one left behind by a deleted app).
// The worker is the one that talks to Docker; the API only checks and queues. A volume that an app mounts is never removed here.
import * as realEngine from './docker.js';
import * as store from './db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @returns {Promise<{ok: true, skipped?: true, removed?: true}>} Throws (and records why on the volume) when it cannot be removed. */
export async function removeVolume({ volumeId }, { eng = realEngine, db = store, log = console.log } = {}) {
  const v = await db.getVolume(volumeId);
  if (!v) {
    log('Skipped: the volume is already gone');
    return { ok: true, skipped: true };
  }
  if (v.state === 'in_use') throw new Error('The volume is mounted by an app, so it was not removed');

  let outcome;
  try {
    outcome = await eng.removeVolumeStrict(v.docker_name);
  } catch (err) {
    await db.setVolumeRemoveError(v.id, String(err.message ?? err)).catch(() => {});
    throw err;
  }
  if (outcome === 'in-use') {
    const message = 'A container still uses this volume, so it was not removed';
    await db.setVolumeRemoveError(v.id, message).catch(() => {});
    throw new Error(message);
  }
  await db.deleteVolumeRow(v.id); // removed, or Docker no longer had it
  log(`Removed volume ${v.docker_name}`);
  return { ok: true, removed: true };
}

/** The BullMQ job 'removevolume' ({volumeId}). */
export async function processRemoveVolumeJob(job, deps = {}) {
  const { volumeId } = job.data ?? {};
  if (typeof volumeId !== 'string' || !UUID_RE.test(volumeId)) throw new Error('Remove-volume job is missing a valid volume id');
  const log = (msg) => {
    console.log(`[job ${job.id}] ${msg}`);
    Promise.resolve(job.log?.(msg)).catch(() => {});
  };
  return removeVolume({ volumeId }, { ...deps, log });
}
