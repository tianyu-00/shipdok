// Requesting and cancelling deployments. All the "latest wins" rules live here, in one place, so
// manual deploys and (later) GitHub webhooks behave identically.
import { withTx } from './db/tx.js';

const ACTIVE = `('building','starting','validating')`;

// Removing a job from Redis is tidiness, not correctness: the database is the source of truth and the
// worker skips any job whose row is no longer queued. So failures here are ignored.
async function removeJobs(queue, jobIds) {
  for (const id of jobIds) {
    try { await queue?.remove?.(String(id)); } catch { /* best effort */ }
  }
}

/**
 * Create a deployment for an app, enqueue it, then supersede that app's older deployments.
 * @param {object} [opts]
 * @param {'manual'|'webhook'} [opts.trigger]
 * @param {string} [opts.commit]      exact commit to build (a webhook push); otherwise the branch head at build time
 * @param {string} [opts.deliveryId]  the GitHub delivery that caused this; at most one deployment per (delivery, app)
 * @param {boolean} [opts.startAfter] start the app after this deployment even though it is stopped (explicit request only)
 * @param {{id: string, image: string, commit: string|null}} [opts.rollbackOf]  a rollback: run this earlier version's existing image instead of building
 * @returns {{ ok: true, deploymentId: string, duplicate?: boolean } | { ok: false, deploymentId: string }}
 */
export async function requestDeployment({ db, queue }, app, { trigger = 'manual', commit = null, deliveryId = null, startAfter = false, rollbackOf = null } = {}) {
  // The settings THIS deployment will use. No secret values belong here.
  const snapshot = {
    repo: app.repo, branch: app.branch, root_dir: app.root_dir,
    container_port: app.container_port, host_port: app.host_port,
    health_path: app.health_path, memory_mb: app.memory_mb, cpus: Number(app.cpus),
  };
  // Which variable versions this deployment is meant to use (names and numbers only, never values).
  const { rows: envRows } = await db.query(
    'SELECT key, version::text AS version FROM app_env_vars WHERE app_id = $1', [app.id]);
  snapshot.env = Object.fromEntries(envRows.map((r) => [r.key, r.version]));

  // Persist FIRST so the worker's claim (queued -> building) always finds a committed row.
  let inserted;
  try {
    inserted = await db.query(
      `INSERT INTO deployments (app_id, trigger, commit_sha, webhook_delivery_id, config_snapshot, rollback_of)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, seq`,
      // A rollback is the old version again: it shows that version's commit, and remembers which deployment it came from.
      [app.id, rollbackOf ? 'rollback' : trigger, rollbackOf ? rollbackOf.commit : commit, deliveryId, snapshot, rollbackOf?.id ?? null],
    );
  } catch (err) {
    // A redelivery of the same webhook must never create a second deployment for the same app.
    if (err.code === '23505' && err.constraint === 'deployments_webhook_delivery_app_key') {
      const { rows } = await db.query('SELECT id FROM deployments WHERE webhook_delivery_id = $1 AND app_id = $2', [deliveryId, app.id]);
      return { ok: true, duplicate: true, deploymentId: rows[0]?.id };
    }
    throw err;
  }
  const { id: deploymentId, seq } = inserted.rows[0];

  try {
    const job = await queue.add('deploy', {
      deploymentId,
      appId: app.id,
      slug: app.slug,
      repo: `https://github.com/${snapshot.repo}.git`,
      repoFullName: snapshot.repo, // owner/repo, used by the worker to request a repo-scoped GitHub token
      installationId: app.github_installation_id ? Number(app.github_installation_id) : undefined,
      ref: snapshot.branch,
      commit: rollbackOf ? undefined : (commit ?? undefined), // exact commit for webhook pushes (a rollback builds nothing)
      reuseImage: rollbackOf?.image,
      dir: snapshot.root_dir,
      containerPort: snapshot.container_port,
      hostPort: snapshot.host_port,
      health: snapshot.health_path ?? undefined,
      memoryMb: snapshot.memory_mb,
      cpus: snapshot.cpus,
      startAfterDeploy: startAfter || undefined, // the worker applies it only if the deployment succeeds
    });
    await db.query('UPDATE deployments SET job_id = $2 WHERE id = $1', [deploymentId, String(job.id)]);
  } catch (err) {
    // Older deployments are deliberately left alone: nothing newer exists to replace them.
    console.error('Enqueue failed:', err.message);
    await db.query(
      `UPDATE deployments SET status = 'failed', finished_at = now(), error_summary = $2, webhook_delivery_id = NULL WHERE id = $1`,
      [deploymentId, 'Could not enqueue the deployment job'],
    );
    return { ok: false, deploymentId };
  }

  // Supersede strictly OLDER deployments of THIS app (by seq, so concurrent requests can never
  // supersede each other in a cycle: the highest seq always survives).
  const { queuedJobIds } = await withTx(db, async (c) => {
    const queued = await c.query(
      `UPDATE deployments
          SET status = 'superseded', cancel_status = 'superseded', superseded_by = $2,
              finished_at = now(), error_summary = 'Superseded by a newer deployment'
        WHERE app_id = $1 AND seq < $3 AND status = 'queued'
        RETURNING job_id`,
      [app.id, deploymentId, seq],
    );
    // Running builds are only flagged; the worker stops them and sets the final status after cleanup.
    await c.query(
      `UPDATE deployments SET cancel_status = 'superseded', superseded_by = $2
        WHERE app_id = $1 AND seq < $3 AND status IN ${ACTIVE} AND cancel_status IS NULL`,
      [app.id, deploymentId, seq],
    );
    return { queuedJobIds: queued.rows.map((r) => r.job_id).filter(Boolean) };
  });
  await removeJobs(queue, queuedJobIds);

  return { ok: true, deploymentId };
}

/**
 * Cancel a deployment.
 *   queued          -> cancelled immediately            ({ kind: 'cancelled' })
 *   building/etc.   -> flagged; the worker stops it     ({ kind: 'requested' })
 *   already final   -> nothing to do                    ({ kind: 'final' })
 */
export async function cancelDeployment({ db, queue }, id) {
  const outcome = await withTx(db, async (c) => {
    // Row lock: a concurrent worker update waits, so we decide on a stable state.
    const { rows } = await c.query('SELECT status, cancel_status, job_id FROM deployments WHERE id = $1 FOR UPDATE', [id]);
    const d = rows[0];
    if (!d) return { kind: 'not_found' };

    if (d.status === 'queued') {
      await c.query(
        `UPDATE deployments
            SET status = 'cancelled', cancel_status = 'cancelled', finished_at = now(),
                error_summary = 'Cancelled by the administrator'
          WHERE id = $1`, [id]);
      return { kind: 'cancelled', jobId: d.job_id };
    }
    if (['building', 'starting', 'validating'].includes(d.status)) {
      // Never downgrade: a deployment already marked superseded keeps that outcome.
      if (!d.cancel_status) await c.query(`UPDATE deployments SET cancel_status = 'cancelled' WHERE id = $1`, [id]);
      return { kind: 'requested' };
    }
    return { kind: 'final' };
  });
  if (outcome.kind === 'cancelled' && outcome.jobId) await removeJobs(queue, [outcome.jobId]);
  return outcome;
}
