// Docker's build cache. It is shared by every build, so it belongs to no app: this is one figure and two actions. The worker measures it
// now and then and does the cleaning (the API never talks to Docker); here we read its last figures and queue the job.
import { Router } from 'express';
import { fact, recordAuditFor } from '../audit.js';
import { z } from 'zod';

// A clean-up that was asked for and never reported back (the worker died) stops blocking new requests after this long.
const STALE_MINUTES = 30;

export const cleanCacheSchema = z.object({ all: z.boolean().optional() }).strict();

const shape = (r) => ({
  totalBytes: r?.total_bytes == null ? null : Number(r.total_bytes),
  reclaimableBytes: r?.reclaimable_bytes == null ? null : Number(r.reclaimable_bytes),
  sampledAt: r?.sampled_at ?? null,
  cleaning: r?.cleaning === true,
  last: r?.last_run_at ? { at: r.last_run_at, all: r.last_all === true, freedBytes: Number(r.last_freed_bytes ?? 0), error: r.last_error ?? null } : null,
});

export function buildCacheRouter({ db, queue }) {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT *, (requested_at IS NOT NULL AND requested_at > now() - make_interval(mins => $1)) AS cleaning FROM build_cache WHERE id = 1`, [STALE_MINUTES]);
      res.json(shape(rows[0]));
    } catch (err) { next(err); }
  });

  // { all: false } (default): remove cache no build has used for a day. { all: true }: every unused entry, so the next builds start from nothing.
  r.post('/clean', async (req, res, next) => {
    try {
      const body = cleanCacheSchema.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json({ error: 'Invalid request', details: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
      if (!queue) return res.status(503).json({ error: 'Job queue unavailable' });
      const all = body.data.all === true;
      // One clean-up at a time: the row says one is waiting or running, and the database decides if two requests race.
      const { rowCount } = await db.query(
        `INSERT INTO build_cache (id, requested_at, requested_all) VALUES (1, now(), $1)
         ON CONFLICT (id) DO UPDATE SET requested_at = now(), requested_all = $1
           WHERE build_cache.requested_at IS NULL OR build_cache.requested_at <= now() - make_interval(mins => $2)`,
        [all, STALE_MINUTES]);
      if (rowCount === 0) return res.status(409).json({ error: 'A clean-up of the build cache is already waiting or running', code: 'already_queued' });
      try {
        await queue.add('cleancache', { all });
      } catch (err) {
        console.error('Enqueue failed:', err.message);
        await db.query('UPDATE build_cache SET requested_at = NULL, requested_all = NULL WHERE id = 1').catch(() => {});
        return res.status(503).json({ error: 'Could not queue the clean-up' });
      }
      await recordAuditFor(db, req, {
        category: 'storage', action: 'build_cache_clean', summary: all ? 'Build cache clean-up asked for: everything unused' : 'Build cache clean-up asked for: what was not used for a day',
        details: [fact('What', all ? 'every unused entry, so the next builds start from nothing' : 'entries no build used for 24 hours')],
      });
      res.status(202).json({ queued: true });
    } catch (err) { next(err); }
  });

  return r;
}
