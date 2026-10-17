// The worker's view of the deployments table. Every update is guarded by "still active"
// so a late or duplicate update can never overwrite a final status.
import pg from "pg";

export const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST ?? "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

const ACTIVE = `('queued','building','starting','validating')`;

// Take ownership of a queued deployment. Returns false if it is no longer queued (cancelled or
// superseded while waiting, or already handled), in which case the worker must do nothing.
export async function claim(id) {
  const { rowCount } = await pool.query(
    `UPDATE deployments SET status = 'building', started_at = now() WHERE id = $1 AND status = 'queued'`,
    [id],
  );
  return rowCount === 1;
}

export const setStatus = (id, status) =>
  pool.query(`UPDATE deployments SET status = $2 WHERE id = $1 AND status IN ${ACTIVE}`, [id, status]);

export const setCommit = (id, sha) => pool.query(`UPDATE deployments SET commit_sha = $2 WHERE id = $1`, [id, sha]);

// Overwrites the snapshot's env map with the variable versions this deployment really used (names and
// version numbers only, never values).
export const recordEnvVersions = (id, versions) =>
  pool.query(
    `UPDATE deployments SET config_snapshot = jsonb_set(config_snapshot, '{env}', $2::jsonb, true)
     WHERE id = $1 AND status IN ${ACTIVE}`,
    [id, JSON.stringify(versions)],
  );

// 'cancelled' | 'superseded' when someone has asked this deployment to stop, otherwise null.
export async function getCancelStatus(id) {
  const { rows } = await pool.query("SELECT cancel_status FROM deployments WHERE id = $1", [id]);
  return rows[0]?.cancel_status ?? null;
}

// The id of a NEWER deployment of the same app that has already succeeded, or null.
// Used to stop an older deployment from replacing a newer one that is already live.
export async function newerSuccess(id) {
  const { rows } = await pool.query(
    `SELECT n.id FROM deployments d
       JOIN deployments n ON n.app_id = d.app_id AND n.seq > d.seq AND n.status = 'successful'
      WHERE d.id = $1 ORDER BY n.seq DESC LIMIT 1`,
    [id],
  );
  return rows[0]?.id ?? null;
}

// Success. If a cancel request arrived too late (the swap had begun) say so, and clear the flag:
// the deployment really did go live, so it must not look like it ended any other way.
export const markSucceeded = (id, image) =>
  pool.query(
    `UPDATE deployments
        SET status = 'successful', image_ref = $2, finished_at = now(),
            error_summary = CASE cancel_status
              WHEN 'cancelled'  THEN 'A cancel was requested too late: the swap had already begun'
              WHEN 'superseded' THEN 'Superseded too late: the swap had already begun'
              ELSE error_summary END,
            cancel_status = NULL
      WHERE id = $1 AND status IN ${ACTIVE}`,
    [id, image],
  );

export const markFailed = (id, error) =>
  pool.query(
    `UPDATE deployments SET status = 'failed', error_summary = $2, finished_at = now()
     WHERE id = $1 AND status IN ${ACTIVE}`,
    [id, String(error).slice(0, 500)],
  );

// The deployment stopped on request (outcome: 'cancelled' | 'superseded') after cleaning up.
export const markStopped = (id, outcome, supersededBy = null) =>
  pool.query(
    `UPDATE deployments
        SET status = $2::text, cancel_status = $2::text, finished_at = now(),
            error_summary = CASE WHEN $2::text = 'cancelled' THEN 'Cancelled by the administrator'
                                 ELSE 'Superseded by a newer deployment' END,
            superseded_by = COALESCE($3::uuid, superseded_by)
      WHERE id = $1 AND status IN ${ACTIVE}`,
    [id, outcome, supersededBy],
  );

// At worker startup nothing can legitimately be mid-flight (one worker, one job at a time).
export async function interruptActive() {
  const { rowCount } = await pool.query(
    `UPDATE deployments SET status = 'interrupted', finished_at = now(),
            error_summary = 'The worker stopped while this deployment was in progress'
     WHERE status IN ('building','starting','validating')`,
  );
  return rowCount;
}
