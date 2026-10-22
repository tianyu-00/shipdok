// GET /api/version: the running version and the newest published one.
import { Router } from 'express';

export function versionRouter({ check }) {
  const r = Router();
  r.get('/', async (req, res) => res.json(await check.status({ fresh: req.query.fresh === '1' })));
  return r;
}
