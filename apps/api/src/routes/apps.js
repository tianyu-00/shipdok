import { Router } from 'express';
import { z } from 'zod';
import { requestDeployment, cancelDeployment } from '../deployments.js';
import { requestControl, CONTROL_ACTIONS } from '../control.js';

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
}).strict();

const UNIQUE_MESSAGES = {
  apps_name_key: 'An app with this name already exists',
  apps_slug_key: 'An app with a matching name already exists',
  apps_host_port_key: 'That host port is already assigned to another app',
};

const DEPLOYMENT_COLUMNS = `id, app_id, commit_sha, trigger, status, image_ref, config_snapshot,
  error_summary, job_id, queued_at, started_at, finished_at, cancel_status, superseded_by`;

// What the worker last reported about the live container (null until it has). Not the same as desired_state.
const RUNTIME = `(SELECT row_to_json(r) FROM (
    SELECT state, last_action, last_error, updated_at FROM app_runtime WHERE app_id = a.id) r)`;

const deploySchema = z.object({ start: z.boolean().optional() }).strict();

export function appsRouter({ db, queue, github = null }) {
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
          `INSERT INTO apps (name, slug, repo, branch, root_dir, container_port, host_port, health_path, memory_mb, cpus)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [a.name, slug, a.repo, a.branch, a.root_dir, a.container_port, a.host_port, a.health_path ?? null, a.memory_mb, a.cpus],
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
          ${RUNTIME} AS runtime
        FROM apps a ORDER BY a.created_at DESC`);
      res.json(rows);
    } catch (err) { next(err); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const { rows } = await db.query(`SELECT a.*, ${RUNTIME} AS runtime FROM apps a WHERE a.id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'App not found' });
      res.json(rows[0]);
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

      // A stopped app stays stopped after a deployment unless the administrator asks for { "start": true }.
      const result = await requestDeployment({ db, queue }, app, { startAfter: body.data.start === true });
      if (!result.ok) {
        return res.status(503).json({ error: 'Could not enqueue the deployment job', deploymentId: result.deploymentId });
      }
      const { rows } = await db.query(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = $1`, [result.deploymentId]);
      res.status(202).json(rows[0]);
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

export function deploymentsRouter({ db, queue }) {
  const r = Router();
  r.get('/:id', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Deployment not found' });
      const { rows } = await db.query(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Deployment not found' });
      res.json(rows[0]);
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
