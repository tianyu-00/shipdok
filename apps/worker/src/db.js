// The worker's view of the deployments table. Every update is guarded by "still active"
// so a late or duplicate update can never overwrite a final status.
import pg from 'pg';

export const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

const ACTIVE = `('queued','building','starting','validating')`;

export const markBuilding = (id) =>
  pool.query(`UPDATE deployments SET status = 'building', started_at = now() WHERE id = $1 AND status = 'queued'`, [id]);

export const setStatus = (id, status) =>
  pool.query(`UPDATE deployments SET status = $2 WHERE id = $1 AND status IN ${ACTIVE}`, [id, status]);

export const setCommit = (id, sha) =>
  pool.query(`UPDATE deployments SET commit_sha = $2 WHERE id = $1`, [id, sha]);

export const markSucceeded = (id, image) =>
  pool.query(
    `UPDATE deployments SET status = 'successful', image_ref = $2, finished_at = now()
     WHERE id = $1 AND status IN ${ACTIVE}`, [id, image]);

export const markFailed = (id, error) =>
  pool.query(
    `UPDATE deployments SET status = 'failed', error_summary = $2, finished_at = now()
     WHERE id = $1 AND status IN ${ACTIVE}`, [id, String(error).slice(0, 500)]);

// At worker startup nothing can legitimately be mid-flight (one worker, one job at a time).
export async function interruptActive() {
  const { rowCount } = await pool.query(
    `UPDATE deployments SET status = 'interrupted', finished_at = now(),
            error_summary = 'The worker stopped while this deployment was in progress'
     WHERE status IN ('building','starting','validating')`);
  return rowCount;
}
