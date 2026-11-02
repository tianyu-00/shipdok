// GET /api/audit: the activity log, newest first.
import { Router } from 'express';
import { AUDIT_CATEGORIES } from '../audit.js';
import { keepDays } from '../lockout.js';

const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export function auditRouter({ db }) {
  const r = Router();
  // `category` narrows to one category, `q` to entries whose summary contains the text, `automatic=1` adds what Shipdok did by itself
  // (a webhook, a schedule); without it only what the administrator did. Up to 500 at a time: the dashboard pages through them.
  r.get('/', async (req, res, next) => {
    try {
      const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
      const { category, q, automatic } = req.query;
      if (category !== undefined && !AUDIT_CATEGORIES.includes(category)) return res.status(400).json({ error: `category is one of ${AUDIT_CATEGORIES.join(', ')}` });
      if (q !== undefined && (typeof q !== 'string' || q.length > 100)) return res.status(400).json({ error: 'q is text of at most 100 characters' });
      const where = [];
      const params = [limit];
      if (category !== undefined) { params.push(category); where.push(`category = $${params.length}`); }
      if (q) { params.push(`%${escapeLike(q.trim())}%`); where.push(`summary ILIKE $${params.length}`); }
      if (automatic !== '1') where.push(`source = 'user'`);
      const { rows } = await db.query(
        `SELECT id, at, category, action, summary, details, actor, address, source, app_id, app_name FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT $1`,
        params,
      );
      res.json({
        entries: rows.map((e) => ({ id: String(e.id), at: e.at, category: e.category, action: e.action, summary: e.summary, details: e.details ?? [], actor: e.actor, address: e.address, source: e.source, appId: e.app_id, appName: e.app_name })),
        keepDays: await keepDays(db),
      });
    } catch (err) {
      next(err);
    }
  });
  return r;
}
