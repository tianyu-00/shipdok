// Persistent storage. An app lists the container paths it wants to keep; each becomes a Docker named volume that every deployment of the
// app mounts. The API only keeps the records: the worker creates, mounts and removes the Docker volumes (the API never touches Docker).
// Removing a path DETACHES its volume (the data stays); only an explicit delete, or "delete the volumes too" when deleting the app, removes data.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { normalizeVolumePaths } from '../volumepaths.js';
export { mountedVolumes } from '../volumes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

const shape = (r) => ({
  id: r.id, path: r.container_path, state: r.state, dockerName: r.docker_name,
  appId: r.app_id, appName: r.app_name_now ?? r.app_name,
  createdAt: r.created_at, stateChangedAt: r.state_changed_at, removeError: r.remove_error,
  // The last measurement (null until the administrator asked for one, or when Docker has no such volume yet).
  sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes), measuredAt: r.measured_at ?? null,
});

// A measurement that was asked for and never reported back (the worker died) stops blocking new requests after this long.
const STALE_MINUTES = 30;

export function appVolumesRouter({ db }) {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const { rows: app } = await db.query('SELECT 1 FROM apps WHERE id = $1', [req.params.id]);
      if (!app[0]) return res.status(404).json({ error: 'App not found' });
      const { rows } = await db.query(
        `SELECT * FROM app_volumes WHERE app_id = $1 AND state IN ('in_use', 'detached') ORDER BY container_path, state_changed_at DESC`, [req.params.id]);
      res.json({ volumes: rows.map(shape) });
    } catch (err) { next(err); }
  });

  // Replace the whole list. A path that is new gets a new volume; one that was removed earlier gets ITS volume back; one that is no longer
  // listed is detached (kept, not mounted). Nothing is deleted. Takes effect with the next deployment.
  r.put('/', async (req, res, next) => {
    let client;
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const parsed = normalizeVolumePaths(req.body?.paths);
      if (parsed.error) return res.status(400).json({ error: parsed.error });

      client = await db.connect();
      await client.query('BEGIN');
      const { rows: apps } = await client.query('SELECT id, name, deleting_at FROM apps WHERE id = $1 FOR UPDATE', [req.params.id]);
      const app = apps[0];
      if (!app) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'App not found' }); }
      if (app.deleting_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This app is being deleted', code: 'deleting' }); }

      const { rows: existing } = await client.query(
        `SELECT * FROM app_volumes WHERE app_id = $1 AND state IN ('in_use', 'detached') ORDER BY state_changed_at DESC`, [app.id]);
      const inUse = new Map(existing.filter((v) => v.state === 'in_use').map((v) => [v.container_path, v]));
      const detached = new Map();
      for (const v of existing.filter((x) => x.state === 'detached')) if (!detached.has(v.container_path)) detached.set(v.container_path, v); // the newest

      for (const path of parsed.paths) {
        if (inUse.has(path)) continue;
        const back = detached.get(path);
        if (back) {
          await client.query(`UPDATE app_volumes SET state = 'in_use', remove_error = NULL, app_name = $2, state_changed_at = now() WHERE id = $1`, [back.id, app.name]);
        } else {
          const id = randomUUID();
          await client.query(`INSERT INTO app_volumes (id, app_id, app_name, container_path, docker_name) VALUES ($1, $2, $3, $4, $5)`, [id, app.id, app.name, path, `shipdok-vol-${id}`]);
        }
      }
      for (const [path, v] of inUse) {
        if (!parsed.paths.includes(path)) await client.query(`UPDATE app_volumes SET state = 'detached', state_changed_at = now() WHERE id = $1`, [v.id]);
      }
      const { rows } = await client.query(
        `SELECT * FROM app_volumes WHERE app_id = $1 AND state IN ('in_use', 'detached') ORDER BY container_path, state_changed_at DESC`, [app.id]);
      await client.query('COMMIT');
      res.json({ volumes: rows.map(shape) });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client?.release();
    }
  });

  return r;
}

/** Volumes that are kept without being mounted (detached, or left behind by a deleted app), and deleting one. */
export function volumesRouter({ db, queue }) {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT v.*, a.name AS app_name_now FROM app_volumes v LEFT JOIN apps a ON a.id = v.app_id
          WHERE v.state IN ('detached', 'orphaned') ORDER BY v.state_changed_at DESC, v.container_path`);
      res.json({ volumes: rows.map(shape) });
    } catch (err) { next(err); }
  });

  // Sizes are measured on request only (Docker is slow at adding a volume up). The worker does it; the API just records the request and says how it stands.
  r.get('/sizes', async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT s.finished_at, s.last_error, (s.requested_at IS NOT NULL AND s.requested_at > now() - make_interval(mins => $1)) AS measuring,
                (SELECT COALESCE(sum(size_bytes), 0)::bigint FROM app_volumes) AS total_bytes,
                (SELECT count(*)::int FROM app_volumes WHERE measured_at IS NOT NULL AND size_bytes IS NOT NULL) AS measured
           FROM (SELECT 1) one LEFT JOIN volume_sizing s ON s.id = 1`, [STALE_MINUTES]);
      const s = rows[0];
      res.json({ measuring: s?.measuring === true, finishedAt: s?.finished_at ?? null, error: s?.last_error ?? null, totalBytes: Number(s?.total_bytes ?? 0), measured: s?.measured ?? 0 });
    } catch (err) { next(err); }
  });

  r.post('/sizes', async (req, res, next) => {
    try {
      // One measurement at a time: the row says one is waiting or running, and the database decides if two requests race.
      const { rowCount } = await db.query(
        `INSERT INTO volume_sizing (id, requested_at) VALUES (1, now())
         ON CONFLICT (id) DO UPDATE SET requested_at = now()
           WHERE volume_sizing.requested_at IS NULL OR volume_sizing.requested_at <= now() - make_interval(mins => $1)`, [STALE_MINUTES]);
      if (rowCount === 0) return res.status(409).json({ error: 'The sizes are already being measured', code: 'already_measuring' });
      res.status(202).json({ queued: true });
    } catch (err) { next(err); }
  });

  // Delete a volume and its data, for good. Only one that is not mounted; the worker does it (and refuses if a container still uses it).
  r.delete('/:id', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Volume not found' });
      const { rows } = await db.query('SELECT id, state FROM app_volumes WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Volume not found' });
      if (rows[0].state === 'in_use') return res.status(409).json({ error: 'This volume is mounted by an app. Remove its path from the app\'s persistent storage first.', code: 'volume_in_use' });
      if (!queue) return res.status(503).json({ error: 'Job queue unavailable' });
      try {
        await queue.add('removevolume', { volumeId: rows[0].id });
      } catch (err) {
        console.error('Enqueue failed:', err.message);
        return res.status(503).json({ error: 'Could not queue the deletion' });
      }
      res.status(202).json({ queued: true });
    } catch (err) { next(err); }
  });

  return r;
}
