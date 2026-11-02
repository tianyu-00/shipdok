// Persistent storage. An app lists the container paths it wants to keep; each becomes a Docker named volume that every deployment of the
// app mounts. The API only keeps the records: the worker creates, mounts and removes the Docker volumes (the API never touches Docker).
// Removing a path DETACHES its volume (the data stays); only an explicit delete, or "delete the volumes too" when deleting the app, removes data.
import { Router } from 'express';
import { fact, recordAuditFor } from '../audit.js';
import { randomUUID } from 'node:crypto';
import { normalizeVolumePath, normalizeVolumePaths } from '../volumepaths.js';
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
      const added = parsed.paths.filter((p) => !inUse.has(p));
      const removed = [...inUse.keys()].filter((p) => !parsed.paths.includes(p));
      await recordAuditFor(db, req, {
        category: 'storage', action: 'storage_paths', appId: app.id, appName: app.name,
        summary: added.length || removed.length ? `Persistent storage of ${app.name} changed` : `Persistent storage of ${app.name} saved, nothing changed`,
        details: [...(added.length ? [fact('Paths added', added.join(', '))] : []), ...(removed.length ? [fact('Paths detached (the data is kept)', removed.join(', '))] : []),
          ...(added.length || removed.length ? [fact('Takes effect', 'with the next deployment')] : [])],
      });
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

  // Reclaim a kept volume: attach it to an app at a path. Nothing is copied or created (the volume and its data are as they were); the app mounts it from its next deployment.
  r.post('/:id/reclaim', async (req, res, next) => {
    let client;
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Volume not found' });
      const body = req.body ?? {};
      if (!isUuid(body.appId)) return res.status(400).json({ error: 'Invalid request', details: ['appId: choose an app'] });
      const one = normalizeVolumePath(body.path);
      if (one.error) return res.status(400).json({ error: one.error, code: 'bad_path' });

      client = await db.connect();
      await client.query('BEGIN');
      const { rows: apps } = await client.query('SELECT id, name, deleting_at FROM apps WHERE id = $1 FOR UPDATE', [body.appId]);
      const app = apps[0];
      if (!app) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'App not found' }); }
      if (app.deleting_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This app is being deleted', code: 'deleting' }); }
      const { rows: vols } = await client.query('SELECT id, state, app_name FROM app_volumes WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!vols[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Volume not found' }); }
      if (vols[0].state === 'in_use') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This volume is mounted by an app already', code: 'volume_in_use' }); }

      const { rows: mounted } = await client.query(`SELECT container_path FROM app_volumes WHERE app_id = $1 AND state = 'in_use' AND id <> $2`, [app.id, vols[0].id]);
      if (mounted.some((m) => m.container_path === one.path)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `${app.name} already keeps ${one.path}. Choose another path, or remove it from that app first`, code: 'path_in_use' });
      }
      const all = normalizeVolumePaths([...mounted.map((m) => m.container_path), one.path]);
      if (all.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: all.error, code: 'bad_path' }); }

      await client.query(
        `UPDATE app_volumes SET app_id = $2, app_name = $3, container_path = $4, state = 'in_use', remove_error = NULL, state_changed_at = now() WHERE id = $1`,
        [vols[0].id, app.id, app.name, one.path]);
      const { rows } = await client.query('SELECT * FROM app_volumes WHERE id = $1', [vols[0].id]);
      await client.query('COMMIT');
      await recordAuditFor(db, req, {
        category: 'storage', action: 'volume_reclaimed', appId: app.id, appName: app.name, summary: `Kept volume attached to ${app.name} at ${one.path}`,
        details: [fact('Volume', rows[0].docker_name), fact('Was kept from', vols[0].app_name ?? 'a deleted app'), fact('Attached to', app.name), fact('Mounted at', one.path), fact('Takes effect', 'with the next deployment; nothing was copied')],
      });
      res.json({ volume: shape(rows[0]) });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') return res.status(409).json({ error: 'That path is already used by this app', code: 'path_in_use' });
      next(err);
    } finally {
      client?.release();
    }
  });

  // Delete a volume and its data, for good. Only one that is not mounted; the worker does it (and refuses if a container still uses it).
  r.delete('/:id', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Volume not found' });
      const { rows } = await db.query('SELECT id, state, container_path, docker_name, app_name FROM app_volumes WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Volume not found' });
      if (rows[0].state === 'in_use') return res.status(409).json({ error: 'This volume is mounted by an app. Remove its path from the app\'s persistent storage first.', code: 'volume_in_use' });
      if (!queue) return res.status(503).json({ error: 'Job queue unavailable' });
      try {
        await queue.add('removevolume', { volumeId: rows[0].id });
      } catch (err) {
        console.error('Enqueue failed:', err.message);
        return res.status(503).json({ error: 'Could not queue the deletion' });
      }
      await recordAuditFor(db, req, {
        category: 'storage', action: 'volume_deleted', appName: rows[0].app_name, summary: `Volume deletion asked for: ${rows[0].container_path} of ${rows[0].app_name ?? 'a deleted app'}`,
        details: [fact('Volume', rows[0].docker_name), fact('Path', rows[0].container_path), fact('Was kept from', rows[0].app_name ?? 'a deleted app'), fact('Its data', 'deleted for good')],
      });
      res.status(202).json({ queued: true });
    } catch (err) { next(err); }
  });

  return r;
}
