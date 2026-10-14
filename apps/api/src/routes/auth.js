import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { hash, verify } from '@node-rs/argon2'; // argon2id by default; prebuilt binaries (no compiling on the Pi)
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,64}$/;

// Verify against a dummy hash for unknown users so response time doesn't reveal who exists.
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hash('not-a-real-password'));

const limiter = (max) => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again later' },
});

const regenerate = (req) => new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
const save = (req) => new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));

async function startSession(req, userId) {
  await regenerate(req); // new session ID on privilege change (prevents fixation)
  req.session.userId = userId;
  req.session.createdAt = Date.now();
  await save(req);
}

function validCredentials({ username, password }) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Username must be 3-64 characters: letters, numbers, dot, dash, underscore';
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    return 'Password must be 12-256 characters';
  }
  return null;
}

function tokenMatches(given) {
  if (!config.setupToken) return true;
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.setupToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authRouter(db) {
  const r = Router();

  r.get('/status', async (req, res, next) => {
    try {
      const { rows } = await db.query('SELECT EXISTS (SELECT 1 FROM users) AS has_admin');
      res.json({ needsSetup: !rows[0].has_admin, authenticated: Boolean(req.session?.userId) });
    } catch (err) { next(err); }
  });

  // First-run setup. Atomicity comes from the unique index users_single_admin:
  // concurrent requests race on the INSERT and all but one get a unique violation.
  r.post('/setup', limiter(10), async (req, res, next) => {
    try {
      const { username, password, setupToken } = req.body ?? {};
      if (!tokenMatches(setupToken)) return res.status(403).json({ error: 'Invalid setup token' });
      const problem = validCredentials({ username, password });
      if (problem) return res.status(400).json({ error: problem });

      const passwordHash = await hash(password);
      let userId;
      try {
        const { rows } = await db.query(
          'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
          [username, passwordHash],
        );
        userId = rows[0].id;
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Setup has already been completed' });
        throw err;
      }
      await startSession(req, userId);
      res.status(201).json({ username });
    } catch (err) { next(err); }
  });

  r.post('/login', limiter(10), async (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Username and password required' });
      }
      const { rows } = await db.query('SELECT id, password_hash FROM users WHERE username = $1', [username]);
      const user = rows[0];
      let ok = false;
      try {
        ok = await verify(user?.password_hash ?? (await getDummyHash()), password);
      } catch { ok = false; }
      if (!user || !ok) return res.status(401).json({ error: 'Invalid username or password' });

      await startSession(req, user.id);
      res.json({ username });
    } catch (err) { next(err); }
  });

  r.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('shipdok.sid');
      res.status(204).end();
    });
  });

  r.get('/me', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await db.query('SELECT username FROM users WHERE id = $1', [req.session.userId]);
      if (!rows[0]) return res.status(401).json({ error: 'Not authenticated' });
      res.json({ username: rows[0].username });
    } catch (err) { next(err); }
  });

  return r;
}
