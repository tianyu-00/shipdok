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
export const markSucceeded = (id, image, imageBytes = null) =>
  pool.query(
    `UPDATE deployments
        SET status = 'successful', image_ref = $2, image_bytes = $3, finished_at = now(),
            error_summary = CASE cancel_status
              WHEN 'cancelled'  THEN 'A cancel was requested too late: the swap had already begun'
              WHEN 'superseded' THEN 'Superseded too late: the swap had already begun'
              ELSE error_summary END,
            cancel_status = NULL
      WHERE id = $1 AND status IN ${ACTIVE}`, [id, image, imageBytes]);

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
// The administrator can edit an app's settings while it runs, but the running container keeps what the deployment that created
// it used. Health checks of that container must use those settings (the newest successful deployment's snapshot), or an edit
// would make a healthy app look unhealthy until it is redeployed. Old records without the keys fall back to the app's values.
const RUNNING_PORT = `COALESCE((s.snap->>'container_port')::int, a.container_port)`;
const RUNNING_HEALTH = `CASE WHEN s.snap ? 'health_path' THEN s.snap->>'health_path' ELSE a.health_path END`;
const RUNNING_SNAP = `LEFT JOIN LATERAL (SELECT config_snapshot AS snap FROM deployments
                       WHERE app_id = a.id AND status = 'successful' ORDER BY seq DESC LIMIT 1) s ON true`;

export async function getApp(appId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, ${RUNNING_PORT} AS container_port, ${RUNNING_HEALTH} AS health_path,
            a.desired_state, a.keep_previous_images, a.auto_prune
       FROM apps a ${RUNNING_SNAP} WHERE a.id = $1`, [appId]);
  return rows[0] ?? null;
}

// ---- Deleting an app ----
// The app as the deletion needs it. Only an app the API marked as "being deleted" is ever touched.
export async function getAppForDelete(appId) {
  const { rows } = await pool.query('SELECT id, slug, name, deleting_at FROM apps WHERE id = $1', [appId]);
  return rows[0] ?? null;
}

export const setDeleteError = (appId, message) =>
  pool.query('UPDATE apps SET delete_error = $2 WHERE id = $1 AND deleting_at IS NOT NULL', [appId, String(message).slice(0, 500)]);

// The last step, all or nothing: the deployments (apps -> deployments is RESTRICT, so they go first; their build-log records go with
// them), then the app, whose variables, runtime state, crash events, log records and clean-up summary go by cascade.
// Webhook deliveries are history and stay. Returns false if the app was not marked.
export async function deleteAppRows(appId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT 1 FROM apps WHERE id = $1 AND deleting_at IS NOT NULL FOR UPDATE', [appId]);
    if (!rows[0]) { await client.query('ROLLBACK'); return false; }
    await client.query('DELETE FROM deployments WHERE app_id = $1', [appId]);
    await client.query('DELETE FROM apps WHERE id = $1', [appId]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
    `SELECT a.id, a.slug, ${RUNNING_PORT} AS container_port, ${RUNNING_HEALTH} AS health_path, a.desired_state, a.max_restarts,
            r.state AS rt_state, r.next_restart_at, r.health_failures, r.last_death_at, r.last_error
       FROM apps a ${RUNNING_SNAP} LEFT JOIN app_runtime r ON r.app_id = a.id ORDER BY a.created_at`);
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
    // truncated left out (undefined) keeps what was recorded: closing a log must not forget that it was cut short.
    `UPDATE log_files SET bytes = $3, truncated = COALESCE($4::boolean, truncated), ended_at = now() WHERE deployment_id = $1 AND kind = $2`,
    [deploymentId, kind, bytes, truncated ?? null]);


// Which of these deployment ids still exist.
export async function existingDeploymentIds(ids) {
  if (!ids.length) return new Set();
  const { rows } = await pool.query('SELECT id FROM deployments WHERE id = ANY($1::uuid[])', [ids]);
  return new Set(rows.map((r) => r.id));
}

// ---- Runtime logs: per APP, one 'runtime' file for the CURRENT run of its container and one 'runtime_previous' for the
// run before. A new deployment starts a new container, so it resets the log like any restart. ----

// null if there is no such log yet. runStartedAt is the container's StartedAt (ms): a different value means a restart.
export async function getRuntimeLog(appId, kind) {
  const { rows } = await pool.query(
    'SELECT deployment_id, container_id, run_started_at, ended_at, bytes, truncated FROM runtime_logs WHERE app_id = $1 AND kind = $2', [appId, kind]);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    deploymentId: r.deployment_id, containerId: r.container_id,
    runStartedAt: r.run_started_at === null ? null : new Date(r.run_started_at).getTime(),
    endedAt: r.ended_at, bytes: Number(r.bytes), truncated: r.truncated,
  };
}

// A new run of the container begins: a fresh runtime log record.
export const openRuntimeLog = (appId, { deploymentId, containerId, startedAtMs }) =>
  pool.query(
    `INSERT INTO runtime_logs (app_id, kind, deployment_id, container_id, run_started_at)
     VALUES ($1, 'runtime', $2, $3, to_timestamp($4::double precision / 1000.0))
     ON CONFLICT (app_id, kind) DO UPDATE
       SET deployment_id = $2, container_id = $3, bytes = 0, truncated = false, started_at = now(), ended_at = NULL,
           run_started_at = to_timestamp($4::double precision / 1000.0)`,
    [appId, deploymentId, containerId, startedAtMs]);

// The same run is being collected again (the worker restarted, or the log stream dropped).
export const reopenRuntimeLog = (appId) =>
  pool.query(`UPDATE runtime_logs SET ended_at = NULL WHERE app_id = $1 AND kind = 'runtime'`, [appId]);

// The run that just ended becomes "the previous run" (replacing any older one).
export const recordPreviousLog = (appId, { deploymentId, bytes, truncated }) =>
  pool.query(
    `INSERT INTO runtime_logs (app_id, kind, deployment_id, bytes, truncated, ended_at) VALUES ($1, 'runtime_previous', $2, $3, $4, now())
     ON CONFLICT (app_id, kind) DO UPDATE SET deployment_id = $2, bytes = $3, truncated = $4, started_at = now(), ended_at = now()`,
    [appId, deploymentId, bytes, truncated]);

export const updateRuntimeLogBytes = (appId, { bytes, truncated }) =>
  pool.query(`UPDATE runtime_logs SET bytes = $2, truncated = $3 WHERE app_id = $1 AND kind = 'runtime'`, [appId, bytes, truncated]);

export const closeRuntimeLog = (appId, { bytes, truncated }) =>
  pool.query(
    `UPDATE runtime_logs SET bytes = $2, truncated = COALESCE($3::boolean, truncated), ended_at = now() WHERE app_id = $1 AND kind = 'runtime'`,
    [appId, bytes, truncated ?? null]);

// Logs still marked as being written. At worker boot nothing is being written.
export async function listOpenLogs() {
  const { rows } = await pool.query(
    `SELECT deployment_id, app_id, 'build' AS kind FROM log_files WHERE ended_at IS NULL
     UNION ALL
     SELECT NULL, app_id, kind FROM runtime_logs WHERE ended_at IS NULL`);
  return rows.map((r) => ({ deploymentId: r.deployment_id, appId: r.app_id, kind: r.kind }));
}

// Closes an unfinished runtime log (any kind) at boot with its real size, keeping the recorded "cut short" flag.
export const closeRuntimeLogKind = (appId, kind, { bytes }) =>
  pool.query('UPDATE runtime_logs SET bytes = $3, ended_at = now() WHERE app_id = $1 AND kind = $2', [appId, kind, bytes]);

// ---- Image retention ----

// Successful deployments that still have an image, newest first. The first distinct image is the live version.
export async function listVersions(appId) {
  const { rows } = await pool.query(
    `SELECT id, image_ref, image_bytes FROM deployments
      WHERE app_id = $1 AND status = 'successful' AND image_ref IS NOT NULL AND image_removed_at IS NULL
      ORDER BY seq DESC`, [appId]);
  return rows.map((r) => ({ id: r.id, imageRef: r.image_ref, bytes: r.image_bytes === null ? null : Number(r.image_bytes) }));
}

// What a deployment that has not finished still needs: its own id (its image is being built) and, for a rollback
// that is waiting its turn, the image it is going to reuse.
export async function activeProtections(appId) {
  const { rows } = await pool.query(
    `SELECT d.id, src.image_ref AS reuse_image
       FROM deployments d LEFT JOIN deployments src ON src.id = d.rollback_of
      WHERE d.app_id = $1 AND d.status IN ${ACTIVE}`, [appId]);
  return {
    deploymentIds: new Set(rows.map((r) => r.id)),
    images: new Set(rows.map((r) => r.reuse_image).filter(Boolean)),
  };
}

// These images are gone: their deployments stay in the history, but can no longer be rolled back to.
export const markImagesRemoved = (appId, images) =>
  images.length
    ? pool.query(
        `UPDATE deployments SET image_removed_at = now()
          WHERE app_id = $1 AND image_ref = ANY($2::text[]) AND image_removed_at IS NULL`, [appId, images])
    : Promise.resolve();

export const recordCleanup = (appId, { trigger, removed, freedBytes, skipped, error = null }) =>
  pool.query(
    `INSERT INTO app_cleanup (app_id, trigger, images_removed, freed_bytes, skipped, error)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (app_id) DO UPDATE
       SET last_run_at = now(), trigger = $2, images_removed = $3, freed_bytes = $4, skipped = $5, error = $6`,
    [appId, trigger, removed, freedBytes, skipped, error]);
