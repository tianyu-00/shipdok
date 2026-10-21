// Old images of ALL apps in one place. Each app already has its own list and its own clean-up (routes/apps.js, /:id/images and /:id/prune); this adds the
// whole: how much old versions could free in total, one button that cleans every app, one switch for the automatic clean-up of every app, and the size at
// which the dashboard should say so. The worker does the cleaning (the API never talks to Docker): here the jobs are queued, one per app.
import { Router } from 'express';
import { z } from 'zod';
import { listVersions, prunableBytes } from '../images.js';

const NOTICE_KEY = 'images_notice_bytes';
const MIN_NOTICE = 100 * 1024 * 1024; // 100 MB .. 10 TB; empty (null) = never say anything (the default)
const MAX_NOTICE = 10 * 1024 ** 4;

export const noticeSchema = z.object({ thresholdBytes: z.number().int().min(MIN_NOTICE).max(MAX_NOTICE).nullable() }).strict();
export const autoCleanupSchema = z.object({ enabled: z.boolean() }).strict();

const invalid = (body) => ({ error: 'Invalid request', details: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });

export function imagesRouter({ db, queue }) {
  const r = Router();

  async function threshold() {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [NOTICE_KEY]);
    const v = rows[0]?.value;
    return Number.isSafeInteger(v) && v > 0 ? v : null;
  }

  // The total an immediate clean-up could free (an upper bound: versions of one app share files), by app, and whether that is over the user's size.
  async function overview() {
    const { rows: apps } = await db.query('SELECT id, name, slug, keep_previous_images, auto_prune FROM apps WHERE deleting_at IS NULL ORDER BY name');
    const perApp = [];
    for (const a of apps) {
      const versions = await listVersions(db, a.id, a.keep_previous_images);
      const prunable = new Set(versions.filter((v) => v.state === 'prunable').map((v) => v.image));
      perApp.push({ appId: a.id, name: a.name, slug: a.slug, reclaimableBytes: prunableBytes(versions), images: prunable.size, autoCleanup: a.auto_prune });
    }
    perApp.sort((x, y) => y.reclaimableBytes - x.reclaimableBytes);
    const reclaimableBytes = perApp.reduce((n, a) => n + a.reclaimableBytes, 0);
    const noticeBytes = await threshold();
    return {
      reclaimableBytes,
      apps: perApp,
      autoCleanup: { on: perApp.filter((a) => a.autoCleanup).length, total: perApp.length },
      thresholdBytes: noticeBytes,
      exceeded: noticeBytes !== null && reclaimableBytes >= noticeBytes,
    };
  }

  r.get('/', async (req, res, next) => {
    try { res.json(await overview()); } catch (err) { next(err); }
  });

  // Clean up every app now: the same clean-up as an app's own button (its live version and the chosen number of earlier ones stay), once per app.
  r.post('/prune', async (req, res, next) => {
    try {
      if (!queue) return res.status(503).json({ error: 'Job queue unavailable' });
      const { rows } = await db.query('SELECT id FROM apps WHERE deleting_at IS NULL ORDER BY name');
      let queued = 0;
      for (const a of rows) {
        try {
          await queue.add('prune', { appId: a.id, trigger: 'manual' });
          queued += 1;
        } catch (err) {
          console.error('Enqueue failed:', err.message);
          if (queued === 0) return res.status(503).json({ error: 'Could not queue the clean-up' });
          break; // some were queued: say how many rather than pretend all were
        }
      }
      res.status(202).json({ queued, apps: rows.length });
    } catch (err) { next(err); }
  });

  // Automatic clean-up on (or off) for every app that exists now. New apps start with it on.
  r.post('/auto-cleanup', async (req, res, next) => {
    try {
      const body = autoCleanupSchema.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json(invalid(body));
      const { rowCount } = await db.query('UPDATE apps SET auto_prune = $1, updated_at = now() WHERE deleting_at IS NULL AND auto_prune IS DISTINCT FROM $1', [body.data.enabled]);
      res.json({ enabled: body.data.enabled, changed: rowCount });
    } catch (err) { next(err); }
  });

  // The size of old images at which the dashboard says so (null = never, the default).
  r.put('/notice', async (req, res, next) => {
    try {
      const body = noticeSchema.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json(invalid(body));
      if (body.data.thresholdBytes === null) await db.query('DELETE FROM settings WHERE key = $1', [NOTICE_KEY]);
      else await db.query(`INSERT INTO settings (key, value) VALUES ($1, to_jsonb($2::bigint)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [NOTICE_KEY, body.data.thresholdBytes]);
      res.json(await overview());
    } catch (err) { next(err); }
  });

  return r;
}
