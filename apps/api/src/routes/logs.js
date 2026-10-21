// Reading and deleting logs, and the storage summary. The worker writes the files; the API reads them and, on the
// administrator's explicit request, removes them: a finished deployment's build log, or an app's runtime logs. A client
// can never change a log's content. Paths come only from stored ids, never from the request.
//   deployment  -> its build log (one per deployment, kept until the deployment is deleted)
//   app         -> its runtime log and the run before it (one pair per app, reset on every restart or deployment)
import { Router } from 'express';
import { stat } from 'node:fs/promises';
import { defaultDiskUsage, diskStatus } from '../disk.js';
import { logFilePath, runtimeLogPath, readChunk, readTail, removeDeploymentLogs, removeRuntimeLogs } from '@shipdok/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
const ACTIVE = ['queued', 'building', 'starting', 'validating'];

// What ?kind= may be, and the stored kind each one means.
const APP_KIND_PARAM = { runtime: 'runtime', previous: 'runtime_previous' };
const DEPLOYMENT_KIND_PARAM = { build: 'build' };

const DEFAULT_LIMIT = 64 * 1024;
const MAX_LIMIT = 1024 * 1024;
const MAX_TAIL = 5000;

// A non-negative whole number from a query string, or undefined when absent, or null when it is not one.
const wholeNumber = (v) => {
  if (v === undefined) return undefined;
  return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
};

// Serves one log file: the query string picks the part (offset/limit or tail) and the kind. `lookup(kind)` finds the
// log's record and file, or null when the deployment/app does not exist.
async function serveLog(req, res, { defaultKind, kinds, lookup, missing }) {
  const kindParam = req.query.kind === undefined ? defaultKind : req.query.kind;
  const kind = typeof kindParam === 'string' && Object.hasOwn(kinds, kindParam) ? kinds[kindParam] : null;
  const offset = wholeNumber(req.query.offset);
  const limit = wholeNumber(req.query.limit);
  const tail = wholeNumber(req.query.tail);
  const bad = kind === null || offset === null || limit === null || tail === null
    || (limit !== undefined && (limit < 1 || limit > MAX_LIMIT))
    || (tail !== undefined && (tail < 1 || tail > MAX_TAIL))
    || (tail !== undefined && (offset !== undefined || limit !== undefined));
  if (bad) return res.status(400).json({ error: 'Invalid kind, offset, limit or tail' });

  const found = await lookup(kind);
  if (!found) return res.status(404).json({ error: missing.owner });
  const result = tail !== undefined ? await readTail(found.file, tail) : await readChunk(found.file, offset ?? 0, limit ?? DEFAULT_LIMIT);
  if (!result) return res.status(404).json({ error: missing.log });

  res.json({
    text: result.text,
    offset: result.start,
    nextOffset: result.next,
    size: result.size,
    complete: found.endedAt !== null && result.next >= result.size, // finished AND everything read
    truncated: found.truncated === true,
    ...(found.deploymentId !== undefined ? { deploymentId: found.deploymentId } : {}),
  });
}

// An app's runtime log: the app's own output since its container last started (?kind=previous for the run before that).
// There is one per app; a new deployment or a restart resets it.
export function appLogsRouter({ db, logDir }) {
  const r = Router();

  r.get('/:id/logs', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      await serveLog(req, res, {
        defaultKind: 'runtime', kinds: APP_KIND_PARAM,
        missing: { owner: 'App not found', log: 'No output has been collected for this app yet' },
        lookup: async (kind) => {
          const { rows } = await db.query(
            `SELECT l.ended_at, l.truncated, l.deployment_id
               FROM apps a LEFT JOIN runtime_logs l ON l.app_id = a.id AND l.kind = $2
              WHERE a.id = $1`, [req.params.id, kind]);
          if (!rows[0]) return null;
          return {
            file: runtimeLogPath(logDir, req.params.id, kind),
            // No record at all (never collected): the file will not exist either, so the reader answers 404.
            endedAt: rows[0].ended_at ?? null, truncated: rows[0].truncated ?? false, deploymentId: rows[0].deployment_id ?? null,
          };
        },
      });
    } catch (err) { next(err); }
  });

  // Explicit deletion of an app's runtime logs (current and previous). Refused while the app's output is still being collected.
  r.delete('/:id/logs', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const { rows: apps } = await db.query('SELECT 1 FROM apps WHERE id = $1', [req.params.id]);
      if (!apps[0]) return res.status(404).json({ error: 'App not found' });
      const { rows: collecting } = await db.query(
        `SELECT 1 FROM runtime_logs WHERE app_id = $1 AND kind = 'runtime' AND ended_at IS NULL`, [req.params.id]);
      if (collecting[0]) return res.status(409).json({ error: 'The app is running and its output is still being collected; stop it first' });

      let freedBytes;
      try {
        freedBytes = await removeRuntimeLogs(logDir, req.params.id);
      } catch (err) {
        console.error('Could not delete log files:', err.code ?? err.message);
        return res.status(500).json({ error: 'The log files could not be deleted (check that the log volume is writable by the API)' });
      }
      const removed = await db.query('DELETE FROM runtime_logs WHERE app_id = $1', [req.params.id]);
      if (removed.rowCount === 0 && freedBytes === 0) return res.status(404).json({ error: 'No runtime logs for this app' });
      res.json({ freedBytes });
    } catch (err) { next(err); }
  });

  return r;
}

export function deploymentLogsRouter({ db, logDir }) {
  const r = Router();

  r.get('/:id/logs', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Deployment not found' });
      await serveLog(req, res, {
        defaultKind: 'build', kinds: DEPLOYMENT_KIND_PARAM,
        missing: { owner: 'Deployment not found', log: 'No log for this deployment' },
        lookup: async (kind) => {
          const { rows } = await db.query(
            `SELECT d.app_id, l.ended_at, l.truncated
               FROM deployments d LEFT JOIN log_files l ON l.deployment_id = d.id AND l.kind = $2
              WHERE d.id = $1`, [req.params.id, kind]);
          if (!rows[0]) return null;
          return { file: logFilePath(logDir, rows[0].app_id, req.params.id, kind), endedAt: rows[0].ended_at ?? null, truncated: rows[0].truncated ?? false };
        },
      });
    } catch (err) { next(err); }
  });

  // Explicit deletion of a finished deployment's logs. The deployment, its status and its error summary stay.
  r.delete('/:id/logs', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Deployment not found' });
      const { rows } = await db.query('SELECT app_id, status FROM deployments WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Deployment not found' });
      if (ACTIVE.includes(rows[0].status)) return res.status(409).json({ error: 'The deployment is still running; its log is still being written' });

      let freedBytes;
      try {
        freedBytes = await removeDeploymentLogs(logDir, rows[0].app_id, req.params.id);
      } catch (err) {
        console.error('Could not delete log files:', err.code ?? err.message);
        // Say what is wrong without revealing paths; the records stay, because the files do too.
        return res.status(500).json({ error: 'The log files could not be deleted (check that the log volume is writable by the API)' });
      }
      const removed = await db.query('DELETE FROM log_files WHERE deployment_id = $1', [req.params.id]);
      if (removed.rowCount === 0 && freedBytes === 0) return res.status(404).json({ error: 'No logs for this deployment' });
      res.json({ freedBytes });
    } catch (err) { next(err); }
  });

  return r;
}

export function storageRouter({ db, logDir, diskUsage = defaultDiskUsage }) {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT l.app_id, a.slug, l.deployment_id, l.kind, l.bytes, l.ended_at
           FROM log_files l JOIN apps a ON a.id = l.app_id
         UNION ALL
         SELECT l.app_id, a.slug, NULL, l.kind, l.bytes, l.ended_at
           FROM runtime_logs l JOIN apps a ON a.id = l.app_id`);
      const perApp = new Map();
      for (const row of rows) {
        // A log still being written has not recorded its size yet: the file on disk is the truth.
        let bytes = Number(row.bytes);
        if (row.ended_at === null) {
          const file = row.kind === 'build' ? logFilePath(logDir, row.app_id, row.deployment_id, 'build') : runtimeLogPath(logDir, row.app_id, row.kind);
          try { bytes = (await stat(file)).size; } catch { bytes = 0; }
        }
        const entry = perApp.get(row.app_id) ?? { appId: row.app_id, slug: row.slug, bytes: 0, files: 0 };
        entry.bytes += bytes;
        entry.files += 1;
        perApp.set(row.app_id, entry);
      }
      const apps = [...perApp.values()].sort((a, b) => b.bytes - a.bytes);

      const disk = await diskStatus(diskUsage, logDir);

      // Images Shipdok has built and still holds, from the sizes recorded when each version went live. One image
      // shared by several deployments (a rollback reuses it) counts once.
      const { rows: imageRows } = await db.query(
        `SELECT app_id, slug, count(*)::int AS images, COALESCE(sum(bytes), 0)::bigint AS bytes FROM (
           SELECT DISTINCT ON (d.app_id, d.image_ref) d.app_id, a.slug, d.image_bytes AS bytes
             FROM deployments d JOIN apps a ON a.id = d.app_id
            WHERE d.status = 'successful' AND d.image_ref IS NOT NULL AND d.image_removed_at IS NULL
         ) x GROUP BY app_id, slug ORDER BY bytes DESC`);
      const imageApps = imageRows.map((r) => ({ appId: r.app_id, slug: r.slug, images: r.images, bytes: Number(r.bytes) }));

      // Persistent volumes, as last measured (the administrator asks for a measurement; until then the sizes are null). Volumes whose app is gone are
      // counted in the total only: they have their own list.
      const { rows: volumeRows } = await db.query(
        `SELECT v.app_id, a.slug, count(*)::int AS count, count(v.size_bytes)::int AS measured, COALESCE(sum(v.size_bytes), 0)::bigint AS bytes
           FROM app_volumes v JOIN apps a ON a.id = v.app_id GROUP BY v.app_id, a.slug ORDER BY bytes DESC`);
      const { rows: volumeTotal } = await db.query(`SELECT COALESCE(sum(size_bytes), 0)::bigint AS bytes, max(measured_at) AS measured_at FROM app_volumes`);
      const volumeApps = volumeRows.map((r) => ({ appId: r.app_id, slug: r.slug, count: r.count, measured: r.measured, bytes: Number(r.bytes) }));

      res.json({
        logs: { totalBytes: apps.reduce((n, a) => n + a.bytes, 0), apps },
        images: { totalBytes: imageApps.reduce((n, a) => n + a.bytes, 0), apps: imageApps },
        volumes: { totalBytes: Number(volumeTotal[0].bytes), measuredAt: volumeTotal[0].measured_at ?? null, apps: volumeApps },
        disk,
      });
    } catch (err) { next(err); }
  });

  return r;
}
