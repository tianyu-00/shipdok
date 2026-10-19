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

// Take ownership of a queued deployment. Returns false if it is no longer queued (cancelled or
// superseded while waiting, or already handled), in which case the worker must do nothing.
export async function claim(id) {
  const { rowCount } = await pool.query(
    `UPDATE deployments SET status = 'building', started_at = now() WHERE id = $1 AND status = 'queued'`, [id]);
  return rowCount === 1;
}

export const setStatus = (id, status) =>
  pool.query(`UPDATE deployments SET status = $2 WHERE id = $1 AND status IN ${ACTIVE}`, [id, status]);

export const setCommit = (id, sha) =>
  pool.query(`UPDATE deployments SET commit_sha = $2 WHERE id = $1`, [id, sha]);

// Overwrites the snapshot's env map with the variable versions this deployment really used (names and
// version numbers only, never values).
export const recordEnvVersions = (id, versions) =>
  pool.query(
    `UPDATE deployments SET config_snapshot = jsonb_set(config_snapshot, '{env}', $2::jsonb, true)
     WHERE id = $1 AND status IN ${ACTIVE}`, [id, JSON.stringify(versions)]);

// 'cancelled' | 'superseded' when someone has asked this deployment to stop, otherwise null.
export async function getCancelStatus(id) {
  const { rows } = await pool.query('SELECT cancel_status FROM deployments WHERE id = $1', [id]);
  return rows[0]?.cancel_status ?? null;
}

// The id of a NEWER deployment of the same app that has already succeeded, or null.
// Used to stop an older deployment from replacing a newer one that is already live.
export async function newerSuccess(id) {
  const { rows } = await pool.query(
    `SELECT n.id FROM deployments d
       JOIN deployments n ON n.app_id = d.app_id AND n.seq > d.seq AND n.status = 'successful'
      WHERE d.id = $1 ORDER BY n.seq DESC LIMIT 1`, [id]);
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
      WHERE id = $1 AND status IN ${ACTIVE}`, [id, image]);

export const markFailed = (id, error) =>
  pool.query(
    `UPDATE deployments SET status = 'failed', error_summary = $2, finished_at = now()
     WHERE id = $1 AND status IN ${ACTIVE}`, [id, String(error).slice(0, 500)]);

// The deployment stopped on request (outcome: 'cancelled' | 'superseded') after cleaning up.
export const markStopped = (id, outcome, supersededBy = null) =>
  pool.query(
    `UPDATE deployments
        SET status = $2::text, cancel_status = $2::text, finished_at = now(),
            error_summary = CASE WHEN $2::text = 'cancelled' THEN 'Cancelled by the administrator'
                                 ELSE 'Superseded by a newer deployment' END,
            superseded_by = COALESCE($3::uuid, superseded_by)
      WHERE id = $1 AND status IN ${ACTIVE}`, [id, outcome, supersededBy]);

// Remember which GitHub App installation covers an app's repository (found at deploy time).
export const setInstallationId = (appId, installationId) =>
  pool.query(
    `UPDATE apps SET github_installation_id = $2, updated_at = now()
      WHERE id = $1 AND github_installation_id IS DISTINCT FROM $2`, [appId, installationId]);

// At worker startup nothing can legitimately be mid-flight (one worker, one job at a time).
export async function interruptActive() {
  const { rowCount } = await pool.query(
    `UPDATE deployments SET status = 'interrupted', finished_at = now(),
            error_summary = 'The worker stopped while this deployment was in progress'
     WHERE status IN ('building','starting','validating')`);
  return rowCount;
}

// ---- Apps: what the control actions need ----
export async function getApp(appId) {
  const { rows } = await pool.query(
    'SELECT id, slug, container_port, health_path, desired_state FROM apps WHERE id = $1', [appId]);
  return rows[0] ?? null;
}

export async function getDesiredState(appId) {
  const { rows } = await pool.query('SELECT desired_state FROM apps WHERE id = $1', [appId]);
  return rows[0]?.desired_state ?? null;
}

export const setDesiredState = (appId, state) =>
  pool.query('UPDATE apps SET desired_state = $2, updated_at = now() WHERE id = $1', [appId, state]);

// What the live container is doing now, for the API to show. `state` may be left out to keep the current one
// (a failed action changes nothing about the container); a first record with no state is 'stopped'.
// `resetCrashes` (a manual start/restart, or a new version going live) forgives earlier crashes: the window counts from now.
export const setRuntime = (appId, { state = null, action, error = null, resetCrashes = false }) =>
  pool.query(
    `INSERT INTO app_runtime (app_id, state, last_action, last_error, crash_reset_at)
     VALUES ($1, COALESCE($2, 'stopped'), $3, $4, CASE WHEN $5::boolean THEN now() END)
     ON CONFLICT (app_id) DO UPDATE
       SET state = COALESCE($2, app_runtime.state), last_action = $3, last_error = $4, updated_at = now(),
           crash_reset_at = CASE WHEN $5::boolean THEN now() ELSE app_runtime.crash_reset_at END,
           health_failures = CASE WHEN $5::boolean THEN 0 ELSE app_runtime.health_failures END,
           next_restart_at = CASE WHEN $5::boolean THEN NULL ELSE app_runtime.next_restart_at END`,
    [appId, state, action, error === null ? null : String(error).slice(0, 500), resetCrashes]);

// ---- The monitor ----
const ms = (d) => (d == null ? null : new Date(d).getTime());

// Every app with what we last recorded about it, as plain numbers (milliseconds) the monitor can compare.
export async function listSupervised() {
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.container_port, a.health_path, a.desired_state, a.max_restarts,
            r.state AS rt_state, r.next_restart_at, r.health_failures, r.last_death_at, r.last_error
       FROM apps a LEFT JOIN app_runtime r ON r.app_id = a.id ORDER BY a.created_at`);
  return rows.map((r) => ({
    id: r.id, slug: r.slug, containerPort: r.container_port, healthPath: r.health_path,
    desired: r.desired_state, maxRestarts: r.max_restarts,
    runtime: r.rt_state === null ? null : {
      state: r.rt_state, nextRestartAt: ms(r.next_restart_at), healthFailures: r.health_failures,
      lastDeathAt: ms(r.last_death_at), error: r.last_error,
    },
  }));
}

// Crashes (not outside stops, not reboot recoveries) in the window, ignoring any that a manual start already forgave.
export async function countRecentCrashes(appId, sinceMs) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM app_crash_events e
       LEFT JOIN app_runtime r ON r.app_id = e.app_id
      WHERE e.app_id = $1 AND e.cause = 'crash'
        AND e.occurred_at > to_timestamp($2::double precision / 1000.0)
        AND (r.crash_reset_at IS NULL OR e.occurred_at > r.crash_reset_at)`, [appId, sinceMs]);
  return rows[0].n;
}

// Applies one decision from supervisor.decide(): the runtime row and the crash event, together or not at all, so an
// exit is never counted twice and never lost between the two writes.
export async function applyMonitorUpdate(appId, u, at = Date.now()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO app_runtime (app_id, state, last_action, last_error, health_failures, next_restart_at,
                                last_exit_code, oom_killed, last_death_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000.0), $7, COALESCE($8::boolean, false),
               to_timestamp($9::double precision / 1000.0))
       ON CONFLICT (app_id) DO UPDATE SET
         state = $2, last_error = $4, health_failures = $5, next_restart_at = to_timestamp($6::double precision / 1000.0),
         last_action = COALESCE($3, app_runtime.last_action),
         last_exit_code = COALESCE($7, app_runtime.last_exit_code),
         oom_killed = COALESCE($8::boolean, app_runtime.oom_killed),
         last_death_at = COALESCE(to_timestamp($9::double precision / 1000.0), app_runtime.last_death_at),
         updated_at = now()`,
      [appId, u.state, u.action, u.error === null ? null : String(u.error).slice(0, 500), u.healthFailures, u.nextRestartAt,
        u.death?.exitCode ?? null, u.death ? u.death.oomKilled : null, u.death?.at ?? null]);
    if (u.event) {
      await client.query(
        `INSERT INTO app_crash_events (app_id, occurred_at, cause, exit_code, oom_killed, action)
         VALUES ($1, to_timestamp($2::double precision / 1000.0), $3, $4, $5, $6)`,
        [appId, at, u.event.cause, u.event.exitCode, u.event.oomKilled, u.event.action]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- Log files (the text is on disk; these rows say it exists and how big it is) ----
export const openLogFile = (appId, deploymentId, kind) =>
  pool.query(
    `INSERT INTO log_files (deployment_id, app_id, kind) VALUES ($1, $2, $3)
     ON CONFLICT (deployment_id, kind) DO UPDATE
       SET bytes = 0, truncated = false, started_at = now(), ended_at = NULL`,
    [deploymentId, appId, kind]);

export const closeLogFile = (deploymentId, kind, { bytes, truncated }) =>
  pool.query(
    `UPDATE log_files SET bytes = $3, truncated = $4, ended_at = now() WHERE deployment_id = $1 AND kind = $2`,
    [deploymentId, kind, bytes, truncated]);

// Build logs a worker that died never closed.
export async function listOpenBuildLogs() {
  const { rows } = await pool.query(
    `SELECT deployment_id, app_id FROM log_files WHERE kind = 'build' AND ended_at IS NULL`);
  return rows.map((r) => ({ deploymentId: r.deployment_id, appId: r.app_id }));
}

// Which of these deployment ids still exist.
export async function existingDeploymentIds(ids) {
  if (!ids.length) return new Set();
  const { rows } = await pool.query('SELECT id FROM deployments WHERE id = ANY($1::uuid[])', [ids]);
  return new Set(rows.map((r) => r.id));
}
