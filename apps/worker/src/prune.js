// Image retention. An app keeps the image of its live version plus the `keep_previous_images` versions before it
// (default 1), so a rollback is always possible; everything else Shipdok built for the app can be removed.
//
// Runs as a job on the same queue as deployments (one at a time, so it can never remove an image a deployment is
// about to use) and only when asked, or after a deployment if the app has auto_prune on. It never touches logs,
// volumes, containers, or anything that is not labelled as this app's own image.
import * as realEngine from './docker.js';
import * as store from './db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_RE = /^shipdok\/[a-z0-9][a-z0-9-]{0,39}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The tags that must stay: the retained versions, whatever a live container runs, what a waiting deployment needs.
async function protectedTags(appId, app, { eng, db }) {
  const versions = await db.listVersions(appId);
  const retained = [];
  for (const v of versions) if (!retained.includes(v.imageRef)) retained.push(v.imageRef); // one image can serve several deployments (a rollback reuses one)
  const keep = new Set(retained.slice(0, 1 + app.keep_previous_images));

  for (const c of await eng.findContainers({ appId, role: 'live' })) {
    const image = await eng.containerImage(c).catch(() => null);
    if (image) keep.add(image);
  }
  const active = await db.activeProtections(appId);
  for (const image of active.images) keep.add(image);
  return { keep, activeDeploymentIds: active.deploymentIds, versions };
}

/**
 * @param {{appId: string, trigger: 'manual'|'auto'}} job
 * @returns {Promise<{ok: true, removed: number, freedBytes: number, skipped: number} | {ok: true, skipped: true}>}
 */
export async function pruneApp({ appId, trigger = 'manual' }, { eng = realEngine, db = store, log = console.log } = {}) {
  const app = await db.getApp(appId);
  if (!app) {
    log('Skipped prune: the app no longer exists');
    return { ok: true, skipped: true };
  }

  const { keep, activeDeploymentIds, versions } = await protectedTags(appId, app, { eng, db });
  const images = await eng.listAppImages(appId);

  const removedTags = [];
  const layersBefore = await eng.imageLayersSize().catch(() => null);
  let skipped = 0;
  for (const img of images) {
    if (keep.has(img.tag) || activeDeploymentIds.has(img.deploymentId) || !TAG_RE.test(img.tag)) continue;
    const outcome = await eng.removeImageStrict(img.tag);
    if (outcome === 'removed') { removedTags.push(img.tag); log(`Removed image ${img.tag}`); }
    else if (outcome === 'gone') removedTags.push(img.tag);
    else { skipped++; log(`Kept image ${img.tag}: a container still uses it`); }
  }

  // A version whose image Docker no longer has (removed by hand) cannot be rolled back to: say so in the history.
  const present = new Set(images.map((i) => i.tag));
  for (const v of versions) {
    if (present.has(v.imageRef) || removedTags.includes(v.imageRef)) continue;
    if ((await eng.imageInfo(v.imageRef)) === null) removedTags.push(v.imageRef);
  }
  // What was really freed: the drop in layer usage. (Adding up image sizes would count the base layers every version shares.)
  const layersAfter = layersBefore === null ? null : await eng.imageLayersSize().catch(() => null);
  const freedBytes = layersBefore !== null && layersAfter !== null ? Math.max(0, layersBefore - layersAfter) : 0;
  await db.markImagesRemoved(appId, removedTags);
  await db.recordCleanup(appId, { trigger, removed: removedTags.length, freedBytes, skipped });
  log(`Cleaned up ${app.slug}: ${removedTags.length} image(s) removed, about ${Math.round(freedBytes / 1048576)} MB freed${skipped ? `, ${skipped} kept because they are in use` : ''}`);
  return { ok: true, removed: removedTags.length, freedBytes, skipped };
}

/**
 * Removes the image of ONE deployment that was just deleted, if nothing needs it. The same safety checks as a prune,
 * minus the retention rule (the API already refused to delete a retained version).
 */
export async function removeDeploymentImage({ appId, image }, { eng = realEngine, db = store, log = console.log } = {}) {
  if (!TAG_RE.test(image)) throw new Error('Not a Shipdok image');
  const app = await db.getApp(appId);
  if (!app) return { ok: true, skipped: true };
  const { keep, activeDeploymentIds } = await protectedTags(appId, app, { eng, db });
  const own = (await eng.listAppImages(appId)).find((i) => i.tag === image); // only ever this app's own images
  if (!own) return { ok: true, removed: false };
  if (keep.has(image) || activeDeploymentIds.has(own.deploymentId)) {
    log(`Kept image ${image}: it is still needed`);
    return { ok: true, removed: false };
  }
  const outcome = await eng.removeImageStrict(image);
  if (outcome === 'removed') log(`Removed image ${image}`);
  return { ok: true, removed: outcome !== 'in-use' };
}

/** The BullMQ jobs: 'prune' ({appId, trigger}) and 'removeimage' ({appId, image}). */
export async function processPruneJob(job, deps = {}) {
  const { appId } = job.data ?? {};
  if (typeof appId !== 'string' || !UUID_RE.test(appId)) throw new Error('Prune job is missing a valid app id');
  const log = (msg) => {
    console.log(`[job ${job.id}] ${msg}`);
    Promise.resolve(job.log?.(msg)).catch(() => {});
  };
  if (job.name === 'removeimage') {
    if (typeof job.data.image !== 'string') throw new Error('Image removal job is missing the image');
    return removeDeploymentImage({ appId, image: job.data.image }, { ...deps, log });
  }
  return pruneApp({ appId, trigger: job.data.trigger === 'auto' ? 'auto' : 'manual' }, { ...deps, log });
}
