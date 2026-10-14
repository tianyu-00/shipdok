import { config } from '../config.js';

export function requireAuth(req, res, next) {
  const s = req.session;
  if (!s?.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (Date.now() - s.createdAt > config.maxLifetimeMs) {
    return s.destroy(() => res.status(401).json({ error: 'Session expired' }));
  }
  next();
}
