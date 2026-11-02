// Backups of Shipdok itself (the database and the platform secrets, one file each). The worker makes them (it has Docker); here we ask for one, say what
// exists and how the schedule stands, keep the passphrase, serve a file for download and delete one. The files live in a volume the API can read and delete in
// (BACKUP_DIR). A backup holds every secret, so downloading one and changing the passphrase ask for the password again and are recorded in the sign-ins list.
import { Router } from 'express';
import { z } from 'zod';
import { verify } from '@node-rs/argon2';
import { createReadStream, existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeVolumePaths } from '../volumepaths.js';
import { BACKUP_PASSPHRASE_CONTEXT, backupFilePath, backupPassphraseProblem, encryptSecret, nextSlot, normalizeSchedule, restorePassphraseContext } from '@shipdok/shared';
import { limiter } from '../authutil.js';
import { addressOf, recordAttempt } from '../lockout.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SCHEDULE_KEY = 'backup_schedule';
export const PASSPHRASE_KEY = 'backup_passphrase';
export const PASSPHRASE_CONTEXT = BACKUP_PASSPHRASE_CONTEXT; // what the stored passphrase is bound to (the worker uses the same)

export const scheduleSchema = z.object({
  frequency: z.enum(['off', 'daily', 'weekly']),
  hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6),
  keep: z.number().int().min(1).max(60),
}).strict();
export const passphraseSchema = z.object({ password: z.string().min(1), passphrase: z.string().nullable() }).strict();
export const volumeSettingsSchema = z.object({
  frequency: z.enum(['off', 'daily', 'weekly']),
  hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6),
  stop: z.boolean(),
  keep: z.number().int().min(1).max(60),
}).strict();
export const RESTORE_MODES = ['replace', 'add', 'empty'];
export const restoreSchema = z.object({
  password: z.string().min(1),
  mode: z.enum(RESTORE_MODES),
  safetyBackup: z.boolean(),
  passphrase: z.string().min(1).max(256).nullable().optional(),
}).strict();
export const reclaimSchema = restoreSchema.extend({ appId: z.string().regex(UUID_RE) }).strict();
export const downloadSchema = z.object({ password: z.string().min(1) }).strict();

const invalid = (parsed) => ({ error: 'Invalid request', details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });

const shape = (r) => ({
  id: r.id, kind: r.kind, appId: r.app_id, appName: r.app_name, volumeCount: r.volume_count, status: r.status, trigger: r.trigger, requestedAt: r.requested_at, startedAt: r.started_at, finishedAt: r.finished_at,
  sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes), encrypted: r.encrypted, verified: r.verified, version: r.version, warning: r.warning, error: r.error,
  paths: r.volume_paths ?? null,
  downloadable: r.status === 'ok' && r.filename != null,
  restorable: r.kind === 'volumes' && r.status === 'ok' && r.filename != null && r.app_id != null,
});

const restoreShape = (r) => ({
  id: r.id, backupId: r.backup_id, appId: r.app_id, appName: r.app_name, backupMadeAt: r.backup_made_at, mode: r.mode, safetyBackup: r.safety_backup, safetyBackupId: r.safety_backup_id,
  status: r.status, requestedAt: r.requested_at, startedAt: r.started_at, finishedAt: r.finished_at, volumeCount: r.volume_count, warning: r.warning, error: r.error,
  reclaim: r.reclaim, backupAppName: r.backup_app_name,
});

/**
 * Is the backups folder a volume of its own (so that the backups survive the container being replaced)? Outside a container it always is.
 * A volume is a different device from the folder it is mounted in; the folder above it is part of the container's own storage.
 */
export async function inOwnVolume(dir, { insideContainer = () => existsSync('/.dockerenv'), statFn = stat } = {}) {
  if (!insideContainer()) return true;
  try {
    const [a, b] = await Promise.all([statFn(dir), statFn(dirname(dir))]);
    return a.dev !== b.dev;
  } catch { return false; }
}

export function backupsRouter({ db, backupDir, secretsKey }) {
  const r = Router();

  async function checkPassword(req, res, password) {
    const { rows } = await db.query('SELECT id, username, password_hash FROM users WHERE id = $1', [req.session.userId]);
    if (!rows[0]) { res.status(401).json({ error: 'Not authenticated' }); return null; }
    let ok = false;
    try { ok = await verify(rows[0].password_hash, password); } catch { ok = false; }
    if (!ok) { res.status(403).json({ error: 'The current password is not correct', code: 'wrong_password' }); return null; }
    return rows[0];
  }

  // The apps that have mounted volumes, with what is set for their backups. Sizes are the last measurement (null = never measured).
  async function appsWithVolumes() {
    const { rows } = await db.query(
      `SELECT a.id, a.name, a.volume_backup_frequency, a.volume_backup_hour, a.volume_backup_weekday, a.volume_backup_stop, a.volume_backup_keep,
              count(v.id)::int AS volume_count, sum(v.size_bytes)::bigint AS size_bytes, count(v.size_bytes)::int AS measured,
              (SELECT max(b.finished_at) FROM backups b WHERE b.kind = 'volumes' AND b.app_id = a.id AND b.status = 'ok') AS last_ok_at
         FROM apps a JOIN app_volumes v ON v.app_id = a.id AND v.state = 'in_use'
        WHERE a.deleting_at IS NULL GROUP BY a.id ORDER BY lower(a.name), a.id`);
    return rows.map((a) => {
      const next = nextSlot({ frequency: a.volume_backup_frequency, hour: a.volume_backup_hour, weekday: a.volume_backup_weekday });
      return {
        id: a.id, name: a.name, volumeCount: a.volume_count, sizeBytes: a.measured === a.volume_count ? Number(a.size_bytes) : null, lastBackupAt: a.last_ok_at,
        schedule: { frequency: a.volume_backup_frequency, hour: a.volume_backup_hour, weekday: a.volume_backup_weekday }, nextRunAt: next ? next.toISOString() : null,
        stop: a.volume_backup_stop, keep: a.volume_backup_keep,
      };
    });
  }

  async function overview() {
    const { rows } = await db.query('SELECT * FROM backups ORDER BY requested_at DESC, id LIMIT 200');
    const { rows: stored } = await db.query('SELECT key, value FROM settings WHERE key = ANY($1)', [[SCHEDULE_KEY, PASSPHRASE_KEY]]);
    const byKey = Object.fromEntries(stored.map((s) => [s.key, s.value]));
    const schedule = normalizeSchedule(byKey[SCHEDULE_KEY]);
    const next = nextSlot(schedule);
    return {
      backups: rows.map(shape),
      totalBytes: rows.filter((b) => b.status === 'ok').reduce((n, b) => n + Number(b.size_bytes ?? 0), 0),
      schedule,
      nextRunAt: next ? next.toISOString() : null,
      apps: await appsWithVolumes(),
      restores: (await db.query('SELECT * FROM volume_restores ORDER BY requested_at DESC, id LIMIT 20')).rows.map(restoreShape),
      encryption: { enabled: byKey[PASSPHRASE_KEY] != null },
      persistent: await inOwnVolume(backupDir),
    };
  }

  r.get('/', async (req, res, next) => {
    try { res.json(await overview()); } catch (err) { next(err); }
  });

  // Ask for a backup now. The worker notices within a few seconds. Only one may wait or run at a time.
  r.post('/', limiter(20), async (req, res, next) => {
    try {
      const { rows } = await db.query(`INSERT INTO backups (trigger) VALUES ('manual') ON CONFLICT DO NOTHING RETURNING id`);
      if (!rows[0]) return res.status(409).json({ error: 'A backup is already waiting or running', code: 'already_running' });
      res.status(202).json({ id: rows[0].id });
    } catch (err) { next(err); }
  });

  // Ask for a backup of one app's volumes now.
  r.post('/volumes/:appId', limiter(20), async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.appId)) return res.status(404).json({ error: 'App not found' });
      const { rows: apps } = await db.query('SELECT id FROM apps WHERE id = $1 AND deleting_at IS NULL', [req.params.appId]);
      if (!apps[0]) return res.status(404).json({ error: 'App not found' });
      const { rows: restoring } = await db.query(`SELECT 1 FROM volume_restores WHERE app_id = $1 AND status IN ('queued', 'running') LIMIT 1`, [req.params.appId]);
      if (restoring[0]) return res.status(409).json({ error: 'A restore of this app is waiting or running', code: 'restore_running' });
      const { rows } = await db.query(
        `INSERT INTO backups (trigger, kind, app_id, app_name)
           SELECT 'manual', 'volumes', a.id, a.name FROM apps a
            WHERE a.id = $1 AND EXISTS (SELECT 1 FROM app_volumes v WHERE v.app_id = a.id AND v.state = 'in_use')
         ON CONFLICT DO NOTHING RETURNING id`, [req.params.appId]);
      if (rows[0]) return res.status(202).json({ id: rows[0].id });
      const { rows: mounted } = await db.query(`SELECT 1 FROM app_volumes WHERE app_id = $1 AND state = 'in_use' LIMIT 1`, [req.params.appId]);
      if (!mounted[0]) return res.status(400).json({ error: 'This app has no persistent volumes', code: 'no_volumes' });
      res.status(409).json({ error: 'A backup of this app is already waiting or running', code: 'already_running' });
    } catch (err) { next(err); }
  });

  // What is set for one app's volume backups: in the schedule or not, stop the app while copying, how many to keep.
  r.put('/volumes/:appId/settings', limiter(30), async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.appId)) return res.status(404).json({ error: 'App not found' });
      const parsed = volumeSettingsSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json(invalid(parsed));
      const { frequency, hour, weekday, stop, keep } = parsed.data;
      const { rowCount } = await db.query(
        `UPDATE apps SET volume_backup_frequency = $2, volume_backup_hour = $3, volume_backup_weekday = $4, volume_backup_stop = $5, volume_backup_keep = $6, updated_at = now(),
                volume_backup_changed_at = CASE WHEN (volume_backup_frequency, volume_backup_hour, volume_backup_weekday) IS DISTINCT FROM ($2, $3, $4) THEN now() ELSE volume_backup_changed_at END
          WHERE id = $1 AND deleting_at IS NULL`, [req.params.appId, frequency, hour, weekday, stop, keep]);
      if (rowCount === 0) return res.status(404).json({ error: 'App not found' });
      res.json(await overview());
    } catch (err) { next(err); }
  });

  r.put('/settings', limiter(20), async (req, res, next) => {
    try {
      const parsed = scheduleSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json(invalid(parsed));
      await db.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [SCHEDULE_KEY, JSON.stringify(parsed.data)]);
      res.json(await overview());
    } catch (err) { next(err); }
  });

  // Set (or, with null, remove) the passphrase the backups are encrypted with. Stored encrypted with the platform key, so that scheduled backups can use it.
  // It applies to the NEXT backups: the ones already made keep the passphrase they were made with.
  r.put('/passphrase', limiter(10), async (req, res, next) => {
    try {
      const parsed = passphraseSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json(invalid(parsed));
      const { password, passphrase } = parsed.data;
      if (passphrase !== null) {
        const problem = backupPassphraseProblem(passphrase);
        if (problem) return res.status(400).json({ error: 'Invalid request', details: [`passphrase: ${problem}`] });
      }
      const user = await checkPassword(req, res, password);
      if (!user) return;
      if (passphrase === null) await db.query('DELETE FROM settings WHERE key = $1', [PASSPHRASE_KEY]);
      else {
        await db.query(
          `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
          [PASSPHRASE_KEY, JSON.stringify(encryptSecret(passphrase, secretsKey, PASSPHRASE_CONTEXT))]);
      }
      await recordAttempt(db, { kind: 'backup', username: user.username, address: addressOf(req), success: true });
      res.json(await overview());
    } catch (err) { next(err); }
  });

  // The file itself. POST, not GET: it needs the password, and a password must not sit in an address.
  r.post('/:id/download', limiter(10), async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Backup not found' });
      const parsed = downloadSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json(invalid(parsed));
      const user = await checkPassword(req, res, parsed.data.password);
      if (!user) return;
      const { rows } = await db.query(`SELECT filename, status FROM backups WHERE id = $1`, [req.params.id]);
      const row = rows[0];
      if (!row) return res.status(404).json({ error: 'Backup not found' });
      const path = row.status === 'ok' ? backupFilePath(backupDir, row.filename) : null;
      if (!path) return res.status(409).json({ error: 'That backup has no file to download', code: 'no_file' });
      let size;
      try { size = (await stat(path)).size; } catch { return res.status(410).json({ error: 'The file of that backup is gone from the backups folder', code: 'file_missing' }); }
      await recordAttempt(db, { kind: 'download', username: user.username, address: addressOf(req), success: true });
      res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Content-Disposition': `attachment; filename="${row.filename}"`, 'Cache-Control': 'no-store' });
      createReadStream(path).on('error', (err) => { console.error('Backup download failed:', err.message); res.destroy(); }).pipe(res);
    } catch (err) { next(err); }
  });

  // Restore the volumes of an app from one of its volume backups. A POST with the password (it replaces live data) and a record in the sign-ins list.
  // The worker does it: it stops the app, optionally makes a backup of the current data, writes the files, starts the app again.
  r.post('/:id/restore', limiter(10), async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Backup not found' });
      const parsed = restoreSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json(invalid(parsed));
      const { password, mode, safetyBackup, passphrase } = parsed.data;
      const user = await checkPassword(req, res, password);
      if (!user) return;
      const { rows } = await db.query(
        `SELECT b.id, b.kind, b.status, b.filename, b.finished_at, a.id AS app_id, a.name AS app_name, a.deleting_at
           FROM backups b LEFT JOIN apps a ON a.id = b.app_id WHERE b.id = $1`, [req.params.id]);
      const b = rows[0];
      if (!b) return res.status(404).json({ error: 'Backup not found' });
      if (b.kind !== 'volumes') return res.status(400).json({ error: 'Only a backup of an app\'s volumes can be restored from here', code: 'not_volumes' });
      if (b.status !== 'ok' || !backupFilePath(backupDir, b.filename)) return res.status(409).json({ error: 'That backup has no file to restore from', code: 'no_file' });
      if (!b.app_id || b.deleting_at) return res.status(409).json({ error: 'The app of that backup no longer exists', code: 'app_gone' });
      try { await stat(backupFilePath(backupDir, b.filename)); } catch { return res.status(410).json({ error: 'The file of that backup is gone from the backups folder', code: 'file_missing' }); }
      const { rows: mounted } = await db.query(`SELECT 1 FROM app_volumes WHERE app_id = $1 AND state = 'in_use' LIMIT 1`, [b.app_id]);
      if (!mounted[0]) return res.status(400).json({ error: 'The app has no persistent storage any more', code: 'no_volumes' });
      const { rows: busy } = await db.query(`SELECT 1 FROM backups WHERE app_id = $1 AND status IN ('queued', 'running') LIMIT 1`, [b.app_id]);
      if (busy[0]) return res.status(409).json({ error: 'A backup of this app is being made: try again when it is done', code: 'backup_running' });
      const id = randomUUID();
      const stored = passphrase ? encryptSecret(passphrase, secretsKey, restorePassphraseContext(id)) : null;
      const { rows: made } = await db.query(
        `INSERT INTO volume_restores (id, backup_id, app_id, app_name, backup_made_at, mode, safety_backup, passphrase_enc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING id`,
        [id, b.id, b.app_id, b.app_name, b.finished_at, mode, safetyBackup, stored]);
      if (!made[0]) return res.status(409).json({ error: 'A restore of this app is already waiting or running', code: 'already_running' });
      await recordAttempt(db, { kind: 'restore', username: user.username, address: addressOf(req), success: true });
      res.status(202).json({ id });
    } catch (err) { next(err); }
  });

  // Reclaim a volume backup into ANOTHER app (usually one that was made new): the storage paths the app lacks are added to it as new volumes and the files go in;
  // the paths it has are restored as in a normal restore (mode, safety backup). Same checks and record as a restore. The app mounts the new paths from its next deployment.
  r.post('/:id/reclaim', limiter(10), async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Backup not found' });
      const parsed = reclaimSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json(invalid(parsed));
      const { password, mode, safetyBackup, passphrase, appId } = parsed.data;
      const user = await checkPassword(req, res, password);
      if (!user) return;
      const { rows } = await db.query(`SELECT id, kind, status, filename, finished_at, app_name, volume_paths FROM backups WHERE id = $1`, [req.params.id]);
      const b = rows[0];
      if (!b) return res.status(404).json({ error: 'Backup not found' });
      if (b.kind !== 'volumes') return res.status(400).json({ error: 'Only a backup of an app\'s volumes can be reclaimed', code: 'not_volumes' });
      if (b.status !== 'ok' || !backupFilePath(backupDir, b.filename)) return res.status(409).json({ error: 'That backup has no file to restore from', code: 'no_file' });
      try { await stat(backupFilePath(backupDir, b.filename)); } catch { return res.status(410).json({ error: 'The file of that backup is gone from the backups folder', code: 'file_missing' }); }
      const { rows: apps } = await db.query('SELECT id, name, deleting_at FROM apps WHERE id = $1', [appId]);
      if (!apps[0]) return res.status(404).json({ error: 'App not found' });
      if (apps[0].deleting_at) return res.status(409).json({ error: 'This app is being deleted', code: 'app_gone' });
      // The paths the backup holds (when known) together with what the app keeps must make a valid list; otherwise say so now, before a worker is asked
      if (Array.isArray(b.volume_paths) && b.volume_paths.length) {
        const { rows: have } = await db.query(`SELECT container_path FROM app_volumes WHERE app_id = $1 AND state = 'in_use'`, [appId]);
        const all = normalizeVolumePaths([...new Set([...have.map((h) => h.container_path), ...b.volume_paths])]);
        if (all.error) return res.status(400).json({ error: `The storage paths of this backup cannot be added to ${apps[0].name}: ${all.error}`, code: 'bad_path' });
      }
      const { rows: busy } = await db.query(`SELECT 1 FROM backups WHERE app_id = $1 AND status IN ('queued', 'running') LIMIT 1`, [appId]);
      if (busy[0]) return res.status(409).json({ error: 'A backup of this app is being made: try again when it is done', code: 'backup_running' });
      const id = randomUUID();
      const stored = passphrase ? encryptSecret(passphrase, secretsKey, restorePassphraseContext(id)) : null;
      const { rows: made } = await db.query(
        `INSERT INTO volume_restores (id, backup_id, app_id, app_name, backup_app_name, backup_made_at, mode, safety_backup, passphrase_enc, reclaim)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true) ON CONFLICT DO NOTHING RETURNING id`,
        [id, b.id, appId, apps[0].name, b.app_name, b.finished_at, mode, safetyBackup, stored]);
      if (!made[0]) return res.status(409).json({ error: 'A restore of this app is already waiting or running', code: 'already_running' });
      await recordAttempt(db, { kind: 'restore', username: user.username, address: addressOf(req), success: true });
      res.status(202).json({ id });
    } catch (err) { next(err); }
  });

  r.delete('/:id', limiter(30), async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Backup not found' });
      const { rows } = await db.query(`SELECT filename, status FROM backups WHERE id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Backup not found' });
      if (rows[0].status === 'queued' || rows[0].status === 'running') return res.status(409).json({ error: 'That backup is still being made', code: 'in_progress' });
      const path = backupFilePath(backupDir, rows[0].filename);
      if (path) await rm(path, { force: true });
      await db.query('DELETE FROM backups WHERE id = $1 AND status IN (\'ok\', \'failed\')', [req.params.id]);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  return r;
}
