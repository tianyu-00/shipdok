// Backups of Shipdok itself (the database and the platform secrets, one file each). The worker makes them (it has Docker); here we ask for one, say what
// exists and how the schedule stands, keep the passphrase, serve a file for download and delete one. The files live in a volume the API can read and delete in
// (BACKUP_DIR). A backup holds every secret, so downloading one and changing the passphrase ask for the password again and are recorded in the sign-ins list.
import { Router } from 'express';
import { z } from 'zod';
import { verify } from '@node-rs/argon2';
import { createReadStream, existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BACKUP_PASSPHRASE_CONTEXT, backupFilePath, backupPassphraseProblem, encryptSecret, nextSlot, normalizeSchedule } from '@shipdok/shared';
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
  enabled: z.boolean(),
  stop: z.boolean(),
  keep: z.number().int().min(1).max(60),
}).strict();
export const downloadSchema = z.object({ password: z.string().min(1) }).strict();

const invalid = (parsed) => ({ error: 'Invalid request', details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });

const shape = (r) => ({
  id: r.id, kind: r.kind, appId: r.app_id, appName: r.app_name, volumeCount: r.volume_count, status: r.status, trigger: r.trigger, requestedAt: r.requested_at, startedAt: r.started_at, finishedAt: r.finished_at,
  sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes), encrypted: r.encrypted, verified: r.verified, version: r.version, warning: r.warning, error: r.error,
  downloadable: r.status === 'ok' && r.filename != null,
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
      `SELECT a.id, a.name, a.volume_backup_enabled, a.volume_backup_stop, a.volume_backup_keep,
              count(v.id)::int AS volume_count, sum(v.size_bytes)::bigint AS size_bytes, count(v.size_bytes)::int AS measured,
              (SELECT max(b.finished_at) FROM backups b WHERE b.kind = 'volumes' AND b.app_id = a.id AND b.status = 'ok') AS last_ok_at
         FROM apps a JOIN app_volumes v ON v.app_id = a.id AND v.state = 'in_use'
        WHERE a.deleting_at IS NULL GROUP BY a.id ORDER BY lower(a.name), a.id`);
    return rows.map((a) => ({
      id: a.id, name: a.name, volumeCount: a.volume_count, sizeBytes: a.measured === a.volume_count ? Number(a.size_bytes) : null, lastBackupAt: a.last_ok_at,
      enabled: a.volume_backup_enabled, stop: a.volume_backup_stop, keep: a.volume_backup_keep,
    }));
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
      const { enabled, stop, keep } = parsed.data;
      const { rowCount } = await db.query(
        `UPDATE apps SET volume_backup_enabled = $2, volume_backup_stop = $3, volume_backup_keep = $4, updated_at = now(),
                volume_backup_changed_at = CASE WHEN volume_backup_enabled IS DISTINCT FROM $2 THEN now() ELSE volume_backup_changed_at END
          WHERE id = $1 AND deleting_at IS NULL`, [req.params.appId, enabled, stop, keep]);
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
