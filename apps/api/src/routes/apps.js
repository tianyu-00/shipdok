import { Router } from 'express';
import { z } from 'zod';
import { requestDeployment, cancelDeployment } from '../deployments.js';
import { requestControl, CONTROL_ACTIONS } from '../control.js';
import { diskStatus, defaultDiskUsage } from '../disk.js';
import { listVersions, prunableBytes } from '../images.js';
import { removeDeploymentLogs } from '@shipdok/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

export const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// Root directory: relative, no traversal. (deploy() re-checks this defensively.)
const rootDir = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9._\/-]+$/, 'Use letters, numbers, dot, dash, underscore and slash')
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'Must be a relative path inside the repository');

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Use GitHub owner/repo'),
  branch: z.string().trim().regex(/^[A-Za-z0-9_][A-Za-z0-9._\/-]{0,254}$/, 'Invalid branch name').default('main'),
  root_dir: rootDir.default('.'),
  container_port: z.number().int().min(1).max(65535),
  // Required for now; race-safe auto-allocation is a later milestone item.
  host_port: z.number().int().min(1024).max(65535),
  health_path: z.string().regex(/^\/[^\s]*$/, 'Must start with / and contain no spaces').max(200).nullish(),
  memory_mb: z.number().int().min(64).max(8192).default(512),
  cpus: z.number().min(0.1).max(4).default(1),
  // Automatic restarts allowed within 10 minutes before the app is marked crashed (0 = never restart automatically).
  max_restarts: z.number().int().min(0).max(50).default(5),
  // How many earlier versions' images are kept besides the live one (so a rollback is possible), and whether to clean up
  // automatically after each successful deployment. Cleaning up is normally requested by the administrator.
  keep_previous_images: z.number().int().min(0).max(10).default(1),
  auto_prune: z.boolean().default(false),
}).strict();

const retentionSchema = z.object({
  keep_previous_images: z.number().int().min(0).max(10).optional(),
  auto_prune: z.boolean().optional(),
}).strict().refine((v) => v.keep_previous_images !== undefined || v.auto_prune !== undefined, 'Give keep_previous_images, auto_prune, or both');

const rollbackSchema = z.object({
  deploymentId: z.string().regex(UUID_RE, 'Must be a deployment id').optional(),
  start: z.boolean().optional(),
}).strict();

const UNIQUE_MESSAGES = {
  apps_name_key: 'An app with this name already exists',
  apps_slug_key: 'An app with a matching name already exists',
  apps_host_port_key: 'That host port is already assigned to another app',
};

const DEPLOYMENT_COLUMNS = `id, app_id, commit_sha, trigger, status, image_ref, image_bytes, image_removed_at, rollback_of, config_snapshot,
  error_summary, job_id, queued_at, started_at, finished_at, cancel_status, superseded_by`;

// What the worker last reported about the live container (null until it has). Not the same as desired_state.
const RUNTIME = `(SELECT row_to_json(r) FROM (
    SELECT state, last_action, last_error, last_exit_code, oom_killed, health_failures, next_restart_at, updated_at
      FROM app_runtime WHERE app_id = a.id) r)`;

// What the last clean-up of the app's images did (null until one has run).
const CLEANUP = `(SELECT row_to_json(c) FROM (
    SELECT last_run_at, trigger, images_removed, freed_bytes, skipped, error
      FROM app_cleanup WHERE app_id = a.id) c)`;

// ignoreDiskWarning: the administrator has seen the "disk is nearly full" answer and wants to build anyway.
const deploySchema = z.object({ start: z.boolean().optional(), ignoreDiskWarning: z.boolean().optional() }).strict();

export function appsRouter({ db, queue, github = null, logDir = '', diskUsage = defaultDiskUsage }) {
  const r = Router();

  r.post('/', async (req, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid app settings', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      }
      const a = parsed.data;
      const slug = slugify(a.name);
      if (!slug) return res.status(400).json({ error: 'Name must contain letters or numbers' });

      try {
        const { rows } = await db.query(
          `INSERT INTO apps (name, slug, repo, branch, root_dir, container_port, host_port, health_path, memory_mb, cpus, max_restarts, keep_previous_images, auto_prune)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [a.name, slug, a.repo, a.branch, a.root_dir, a.container_port, a.host_port, a.health_path ?? null, a.memory_mb, a.cpus, a.max_restarts, a.keep_previous_images, a.auto_prune],
        );
        const created = rows[0];
        // Is the GitHub App installed on this repository? Best effort and NEVER blocks creation:
        // public repositories work without it, and the app can be installed later.
        let warning;
        if (github) {
          try {
            const installationId = await github.findInstallationForRepo(a.repo);
            if (installationId) {
              await db.query('UPDATE apps SET github_installation_id = $2 WHERE id = $1', [created.id, installationId]);
              created.github_installation_id = installationId;
            } else {
              warning = 'The Shipdok GitHub App is not installed on this repository. Public repositories still deploy, but private ones will fail and pushes will not trigger deployments until it is installed.';
            }
          } catch {
            warning = 'Could not check whether the GitHub App is installed on this repository.';
          }
        }
        res.status(201).json(warning ? { ...created, warning } : created);
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: UNIQUE_MESSAGES[err.constraint] ?? 'App already exists' });
        throw err;
      }
    } catch (err) { next(err); }
  });

  r.get('/', async (req, res, next) => {
    try {
      const { rows } = await db.query(`
        SELECT a.*,
          (SELECT row_to_json(x) FROM (
             SELECT id, status, commit_sha, queued_at, finished_at FROM deployments
             WHERE app_id = a.id ORDER BY queued_at DESC LIMIT 1) x) AS latest_deployment,
          ${RUNTIME} AS runtime, ${CLEANUP} AS cleanup
        FROM apps a ORDER BY a.created_at DESC`);
      res.json(rows);
    } catch (err) { next(err); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const { rows } = await db.query(`SELECT a.*, ${RUNTIME} AS runtime, ${CLEANUP} AS cleanup FROM apps a WHERE a.id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'App not found' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  });

  // Why the app stopped when it should have been running, newest first (what Shipdok did about each one is in `action`).
  r.get('/:id/crashes', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const { rows: found } = await db.query('SELECT 1 FROM apps WHERE id = $1', [req.params.id]);
      if (!found[0]) return res.status(404).json({ error: 'App not found' });
      const { rows } = await db.query(
        `SELECT occurred_at, cause, exit_code, oom_killed, action FROM app_crash_events
          WHERE app_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 20`, [req.params.id]);
      res.json(rows);
    } catch (err) { next(err); }
  });

  r.get('/:id/deployments', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const { rows } = await db.query(
        `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE app_id = $1 ORDER BY queued_at DESC LIMIT 50`,
        [req.params.id],
      );
      res.json(rows);
    } catch (err) { next(err); }
  });

  // Request a deployment. Older deployments of this app are superseded (see ../deployments.js).
  r.post('/:id/deployments', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const { rows: appRows } = await db.query('SELECT * FROM apps WHERE id = $1', [req.params.id]);
      const app = appRows[0];
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (!queue) return res.status(503).json({ error: 'Deployment queue unavailable' });
      const body = deploySchema.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json({ error: 'Invalid request', details: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });

      // A nearly full disk: say so first. Critical stops the request unless the administrator confirms with
      // { "ignoreDiskWarning": true }; low only adds a warning to the answer.
      const disk = await diskStatus(diskUsage, logDir);
      if (disk?.level === 'critical' && body.data.ignoreDiskWarning !== true) {
        return res.status(409).json({
          error: 'The disk is almost full, so a build may fail or fill it. Free some space (prune old images, delete old logs), or repeat the request with ignoreDiskWarning: true to deploy anyway.',
          code: 'disk_critical', disk,
        });
      }

      // A stopped app stays stopped after a deployment unless the administrator asks for { "start": true }.
      const result = await requestDeployment({ db, queue }, app, { startAfter: body.data.start === true });
      if (!result.ok) {
        return res.status(503).json({ error: 'Could not enqueue the deployment job', deploymentId: result.deploymentId });
      }
      const { rows } = await db.query(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = $1`, [result.deploymentId]);
      const warning = disk?.level === 'critical' ? 'Deployed although the disk is almost full.'
        : disk?.level === 'low' ? `The disk is getting full (${disk.freePercent}% free). Consider pruning old images or deleting old logs.` : undefined;
      res.status(202).json(warning ? { ...rows[0], warning, disk } : rows[0]);
    } catch (err) { next(err); }
  });

  // Rollback: run an earlier version's existing image again. Nothing is cloned or built, so it works offline and needs
  // no disk space. The new deployment uses the app's CURRENT settings and variables (only the image is the old one).
  r.post('/:id/rollback', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const { rows: appRows } = await db.query('SELECT * FROM apps WHERE id = $1', [req.params.id]);
      const app = appRows[0];
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (!queue) return res.status(503).json({ error: 'Deployment queue unavailable' });
      const body = rollbackSchema.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json({ error: 'Invalid request', details: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });

      const versions = await listVersions(db, app.id, app.keep_previous_images);
      const live = versions.find((v) => v.state === 'live');
      if (!live) return res.status(409).json({ error: 'Nothing has been deployed for this app yet' });

      let target;
      if (body.data.deploymentId) {
        target = versions.find((v) => v.deploymentId === body.data.deploymentId);
        if (!target) return res.status(404).json({ error: 'That is not a successful deployment of this app' });
        if (target.state === 'removed') return res.status(409).json({ error: 'The image of that version was removed, so it cannot be rolled back to. Deploy it again from source instead.' });
        if (target.state === 'live') return res.status(409).json({ error: 'That version is already the running one' });
      } else {
        target = versions.find((v) => v.canRollBackTo);
        if (!target) return res.status(409).json({ error: 'There is no earlier version with an image to roll back to' });
      }

      const result = await requestDeployment({ db, queue }, app, {
        startAfter: body.data.start === true,
        rollbackOf: { id: target.deploymentId, image: target.image, commit: target.commit },
      });
      if (!result.ok) return res.status(503).json({ error: 'Could not enqueue the rollback job', deploymentId: result.deploymentId });
      const { rows } = await db.query(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = $1`, [result.deploymentId]);
      res.status(202).json(rows[0]);
    } catch (err) { next(err); }
  });

  // The versions that have an image, and what a clean-up would do to each (the worker does the actual work).
  r.get('/:id/images', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const { rows } = await db.query(`SELECT a.keep_previous_images, a.auto_prune, ${CLEANUP} AS cleanup FROM apps a WHERE a.id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'App not found' });
      const versions = await listVersions(db, req.params.id, rows[0].keep_previous_images);
      res.json({
        keep_previous_images: rows[0].keep_previous_images, auto_prune: rows[0].auto_prune, cleanup: rows[0].cleanup,
        prunableBytes: prunableBytes(versions), versions,
      });
    } catch (err) { next(err); }
  });

  // Ask the worker to clean up this app's images now. It keeps the live version and the retained earlier ones, and
  // never touches logs, volumes or other apps.
  r.post('/:id/prune', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const { rows } = await db.query('SELECT id FROM apps WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'App not found' });
      if (!queue) return res.status(503).json({ error: 'Job queue unavailable' });
      try {
        await queue.add('prune', { appId: req.params.id, trigger: 'manual' });
      } catch (err) {
        console.error('Enqueue failed:', err.message);
        return res.status(503).json({ error: 'Could not queue the clean-up' });
      }
      res.status(202).json({ queued: true });
    } catch (err) { next(err); }
  });

  // How many earlier versions to keep, and whether to clean up automatically.
  r.put('/:id/retention', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const body = retentionSchema.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json({ error: 'Invalid settings', details: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
      const { rows } = await db.query(
        `UPDATE apps SET keep_previous_images = COALESCE($2, keep_previous_images), auto_prune = COALESCE($3, auto_prune), updated_at = now()
          WHERE id = $1 RETURNING keep_previous_images, auto_prune`,
        [req.params.id, body.data.keep_previous_images ?? null, body.data.auto_prune ?? null]);
      if (!rows[0]) return res.status(404).json({ error: 'App not found' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  });

  // Start / stop / restart: record the wish, queue the work for the worker (the only thing with Docker access).
  for (const action of CONTROL_ACTIONS) {
    r.post(`/:id/${action}`, async (req, res, next) => {
      try {
        if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
        const { rows } = await db.query('SELECT * FROM apps WHERE id = $1', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ error: 'App not found' });
        if (!queue) return res.status(503).json({ error: 'Job queue unavailable' });

        const result = await requestControl({ db, queue }, rows[0], action);
        if (!result.ok) return res.status(503).json({ error: 'Could not queue the request' });
        res.status(202).json({ action: result.action, desired_state: result.desired_state });
      } catch (err) { next(err); }
    });
  }

  return r;
}

export function deploymentsRouter({ db, queue, logDir = '' }) {
  const r = Router();
  r.get('/:id', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Deployment not found' });
      const { rows } = await db.query(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Deployment not found' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  });

  // Delete a deployment: its record, its build log, and (through the worker) its image if nothing needs it. Explicit and
  // permanent. Refused while it is running, while a waiting rollback is going to use it, and while it is the version
  // kept for rollback (the live one, or one of the retained earlier ones) and nothing else holds that image.
  r.delete('/:id', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Deployment not found' });
      const { rows } = await db.query(
        `SELECT d.id, d.app_id, d.status, d.image_ref, d.image_removed_at, a.keep_previous_images
           FROM deployments d JOIN apps a ON a.id = d.app_id WHERE d.id = $1`, [req.params.id]);
      const d = rows[0];
      if (!d) return res.status(404).json({ error: 'Deployment not found' });
      if (['queued', 'building', 'starting', 'validating'].includes(d.status)) {
        return res.status(409).json({ error: 'The deployment is still running. Cancel it first.' });
      }
      const { rows: waiting } = await db.query(
        `SELECT 1 FROM deployments WHERE rollback_of = $1 AND status IN ('queued','building','starting','validating') LIMIT 1`, [d.id]);
      if (waiting[0]) return res.status(409).json({ error: 'A rollback to this version is waiting to run' });

      if (d.image_ref && !d.image_removed_at) {
        const versions = await listVersions(db, d.app_id, d.keep_previous_images);
        const mine = versions.find((v) => v.deploymentId === d.id);
        const sharing = versions.filter((v) => v.image === d.image_ref && v.deploymentId !== d.id).length;
        // The newest successful deployment IS the running version (that is how "live" is defined), so its record stays
        // even if an older one shares the image. Any other record may go while another record still holds its image.
        if (mine && versions[0].deploymentId === d.id) {
          return res.status(409).json({ error: 'This is the running version. Deploy a newer one first.' });
        }
        if (mine && (mine.state === 'live' || mine.state === 'previous') && sharing === 0) {
          return res.status(409).json({ error: 'This version is kept so the app can be rolled back to it. Deploy a newer version, or lower the number of versions kept, first.' });
        }
      }

      let freedLogBytes;
      try {
        freedLogBytes = await removeDeploymentLogs(logDir, d.app_id, d.id);
      } catch (err) {
        console.error('Could not delete log files:', err.code ?? err.message);
        return res.status(500).json({ error: 'The log files could not be deleted (check that the log volume is writable by the API). Nothing was deleted.' });
      }
      await db.query('DELETE FROM deployments WHERE id = $1', [d.id]);

      // The image goes when the worker gets to it (it is the only one that talks to Docker). If that cannot be queued,
      // the next clean-up removes it: nothing points at it any more.
      let image = 'none';
      if (d.image_ref && !d.image_removed_at) {
        const { rows: others } = await db.query(
          `SELECT 1 FROM deployments WHERE app_id = $1 AND image_ref = $2 LIMIT 1`, [d.app_id, d.image_ref]);
        if (!others[0] && queue) {
          try { await queue.add('removeimage', { appId: d.app_id, image: d.image_ref }); image = 'queued'; } catch { image = 'failed'; }
        } else if (others[0]) {
          image = 'kept (another deployment uses it)';
        }
      }
      res.json({ deleted: true, freedLogBytes, image });
    } catch (err) { next(err); }
  });

  // Cancel a deployment. Queued ones end immediately (200). A running one is only asked to stop (202):
  // the worker stops it and the final status appears once cleanup is done.
  r.post('/:id/cancel', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Deployment not found' });
      const outcome = await cancelDeployment({ db, queue }, req.params.id);
      if (outcome.kind === 'not_found') return res.status(404).json({ error: 'Deployment not found' });
      if (outcome.kind === 'final') return res.status(409).json({ error: 'This deployment has already finished' });
      const { rows } = await db.query(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = $1`, [req.params.id]);
      res.status(outcome.kind === 'cancelled' ? 200 : 202).json(rows[0]);
    } catch (err) { next(err); }
  });

  return r;
}
