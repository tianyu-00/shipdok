// Which versions of an app still have an image to run, and which of them are protected. The same rule as the worker's
// clean-up (apps/worker/src/prune.js): the live version plus `keep_previous_images` earlier ones stay.
// The API only reads this from the database; the worker is what talks to Docker.

/**
 * Every successful deployment that has an image, newest first, with a state:
 *   live       the version that is running (the newest successful one)
 *   previous   kept so the app can be rolled back to it
 *   prunable   no longer kept: a clean-up would remove its image
 *   removed    its image is gone; the deployment and its logs remain
 * A rollback reuses an older image, so several deployments can share one image and then share its state.
 */
export async function listVersions(db, appId, keepPrevious) {
  const { rows } = await db.query(
    `SELECT id, commit_sha, trigger, finished_at, image_ref, image_bytes, image_removed_at, rollback_of
       FROM deployments
      WHERE app_id = $1 AND status = 'successful' AND image_ref IS NOT NULL
      ORDER BY seq DESC`, [appId]);
  const stateOfImage = new Map();
  let distinct = 0;
  return rows.map((r) => {
    let state;
    if (r.image_removed_at) {
      state = 'removed';
    } else {
      if (!stateOfImage.has(r.image_ref)) {
        stateOfImage.set(r.image_ref, distinct === 0 ? 'live' : distinct <= keepPrevious ? 'previous' : 'prunable');
        distinct += 1;
      }
      state = stateOfImage.get(r.image_ref);
    }
    return {
      deploymentId: r.id, commit: r.commit_sha, trigger: r.trigger, finishedAt: r.finished_at,
      image: r.image_ref, bytes: r.image_bytes === null ? null : Number(r.image_bytes),
      state, rollbackOf: r.rollback_of,
      canRollBackTo: state === 'previous' || state === 'prunable',
    };
  });
}

/** What a clean-up would free right now: each prunable image counted once. */
export function prunableBytes(versions) {
  const seen = new Set();
  let total = 0;
  for (const v of versions) {
    if (v.state !== 'prunable' || seen.has(v.image)) continue;
    seen.add(v.image);
    total += v.bytes ?? 0;
  }
  return total;
}
