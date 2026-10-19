// Reading and deleting a deployment's log, and the storage summary. The worker writes the files; the API reads them
// and, on the administrator's explicit request, removes a finished deployment's. A client can never change a log's
// content. Paths come only from the deployment's stored app id and its own id, never from the request.
import { Router } from 'express';
import { stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logFilePath, readChunk, readTail, removeDeploymentLogs } from '@shipdok/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
const ACTIVE = ['queued', 'building', 'starting', 'validating'];

// What ?kind= may be, and the stored kind each one means.
const KIND_PARAM = { build: 'build', runtime: 'runtime', previous: 'runtime_previous' };

const DEFAULT_LIMIT = 64 * 1024;
const MAX_LIMIT = 1024 * 1024;
const MAX_TAIL = 5000;

// A non-negative whole number from a query string, or undefined when absent, or null when it is not one.
const wholeNumber = (v) => {
  if (v === undefined) return undefined;
  return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
};

// How full is the disk the logs live on? Free space below 20% is a warning, below 10% critical (SPEC.md section 13).
export const LOW_FREE_PERCENT = 20;
export const CRITICAL_FREE_PERCENT = 10;

// The log directory may not exist yet (nothing has been logged), so measure the nearest directory that does.
export async function defaultDiskUsage(path) {
  let p = path;
  for (;;) {
    try {
      const s = await statfs(p);
      return { totalBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bavail };
    } catch (err) {
      const parent = dirname(p);
      if (err.code !== 'ENOENT' || parent === p) throw err;
      p = parent;
    }
  }
}

// Serves one of a deployment's logs: the query string picks the part (offset/limit or tail) and the kind.
async function serveLog({ db, logDir }, req, res, deploymentId, defaultKind) {
  const kindParam = req.query.kind === undefined ? defaultKind : req.query.kind;
  const kind = typeof kindParam === 'string' && Object.hasOwn(KIND_PARAM, kindParam) ? KIND_PARAM[kindParam] : null;
  const offset = wholeNumber(req.query.offset);
  const limit = wholeNumber(req.query.limit);
  const tail = wholeNumber(req.query.tail);
  const bad = kind === null || offset === null || limit === null || tail === null
    || (limit !== undefined && (limit < 1 || limit > MAX_LIMIT))
    || (tail !== undefined && (tail < 1 || tail > MAX_TAIL))
    || (tail !== undefined && (offset !== undefined || limit !== undefined));
  if (bad) return res.status(400).json({ error: 'Invalid kind, offset, limit or tail' });

  const { rows } = await db.query(
    `SELECT d.app_id, l.ended_at, l.truncated
       FROM deployments d LEFT JOIN log_files l ON l.deployment_id = d.id AND l.kind = $2
      WHERE d.id = $1`, [deploymentId, kind]);
  if (!rows[0]) return res.status(404).json({ error: 'Deployment not found' });

  const file = logFilePath(logDir, rows[0].app_id, deploymentId, kind);
  const result = tail !== undefined ? await readTail(file, tail) : await readChunk(file, offset ?? 0, limit ?? DEFAULT_LIMIT);
  if (!result) return res.status(404).json({ error: 'No log for this deployment' });

  res.json({
    text: result.text,
    offset: result.start,
    nextOffset: result.next,
    size: result.size,
    complete: rows[0].ended_at !== null && result.next >= result.size, // finished AND everything read
    truncated: rows[0].truncated === true,
  });
}

// The current deployment's runtime log, by app: the app's own output (?kind=previous for the run before the last restart).
export function appLogsRouter({ db, logDir }) {
  const r = Router();
  r.get('/:id/logs', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'App not found' });
      const { rows: apps } = await db.query('SELECT 1 FROM apps WHERE id = $1', [req.params.id]);
      if (!apps[0]) return res.status(404).json({ error: 'App not found' });
      const { rows } = await db.query(
        `SELECT id FROM deployments WHERE app_id = $1 AND status = 'successful' ORDER BY seq DESC LIMIT 1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'This app has no successful deployment yet' });
      await serveLog({ db, logDir }, req, res, rows[0].id, 'runtime');
    } catch (err) { next(err); }
  });
  return r;
}

export function deploymentLogsRouter({ db, logDir }) {
  const r = Router();

  r.get('/:id/logs', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Deployment not found' });
      await serveLog({ db, logDir }, req, res, req.params.id, 'build');
    } catch (err) { next(err); }
  });

  // Explicit deletion of a finished deployment's logs. The deployment, its status and its error summary stay.
  r.delete('/:id/logs', async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Deployment not found' });
      const { rows } = await db.query('SELECT app_id, status FROM deployments WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Deployment not found' });
      if (ACTIVE.includes(rows[0].status)) return res.status(409).json({ error: 'The deployment is still running; its log is still being written' });
      // The worker is still collecting this deployment's runtime log (its app is running): deleting it now would only make a new one appear.
      const { rows: collecting } = await db.query(
        `SELECT 1 FROM log_files WHERE deployment_id = $1 AND kind = 'runtime' AND ended_at IS NULL`, [req.params.id]);
      if (collecting[0]) return res.status(409).json({ error: 'The app is running and its output is still being collected' });

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
           FROM log_files l JOIN apps a ON a.id = l.app_id`);
      const perApp = new Map();
      for (const row of rows) {
        // A log still being written has not recorded its size yet: the file on disk is the truth.
        let bytes = Number(row.bytes);
        if (row.ended_at === null) {
          try { bytes = (await stat(logFilePath(logDir, row.app_id, row.deployment_id, row.kind))).size; } catch { bytes = 0; }
        }
        const entry = perApp.get(row.app_id) ?? { appId: row.app_id, slug: row.slug, bytes: 0, files: 0 };
        entry.bytes += bytes;
        entry.files += 1;
        perApp.set(row.app_id, entry);
      }
      const apps = [...perApp.values()].sort((a, b) => b.bytes - a.bytes);

      let disk = null;
      try {
        const { totalBytes, freeBytes } = await diskUsage(logDir);
        const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
        disk = {
          totalBytes, freeBytes,
          freePercent: Math.round(freePercent * 10) / 10,
          level: freePercent < CRITICAL_FREE_PERCENT ? 'critical' : freePercent < LOW_FREE_PERCENT ? 'low' : 'ok',
        };
      } catch { /* the rest of the summary is still useful */ }

      res.json({ logs: { totalBytes: apps.reduce((n, a) => n + a.bytes, 0), apps }, disk });
    } catch (err) { next(err); }
  });

  return r;
}
