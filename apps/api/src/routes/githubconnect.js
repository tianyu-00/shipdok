// "Connect GitHub": GitHub's App Manifest flow.
//
//   1. POST /start      the dashboard asks for a prepared app definition and a one-time `state` tied to this session
//   2. (the browser posts the definition to github.com, the administrator confirms once there)
//   3. GET  /callback   GitHub sends the browser back here with a one-time code; the API trades it for the app's credentials
//
// The state is random, lives in the session for ten minutes and is used once, so nobody else can finish the flow for the administrator.
// The code is used once. Credentials go straight into the encrypted store and are never returned, logged or put in a redirect.
import { Router } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { GithubError, exchangeManifestCode, saveGithubApp, githubAppSummary } from '@shipdok/shared';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { limiter } from '../authutil.js';
import { forgetInstallations } from './github.js';
import { sameOrigin } from '../origin.js';
import { addressOf, recordAttempt } from '../lockout.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,33}$/;
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const save = (req) => new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function githubConnectRouter({ db, provider, secretsKey, settings, fetch }) {
  const r = Router();

  r.post('/start', requireAuth, limiter(20), async (req, res, next) => {
    try {
      const { owner, name } = req.body ?? {};
      if (owner !== undefined && owner !== '' && (typeof owner !== 'string' || !ORG_RE.test(owner))) {
        return res.status(400).json({ error: 'The organisation name is not valid (letters, numbers and dashes)' });
      }
      const appName = name === undefined || name === '' ? `Shipdok-${randomBytes(2).toString('hex')}` : name;
      if (typeof appName !== 'string' || !NAME_RE.test(appName)) {
        return res.status(400).json({ error: 'The app name must be 1-34 characters: letters, numbers, spaces, dot, dash, underscore' });
      }
      if (await githubAppSummary(db)) {
        return res.status(409).json({ error: 'GitHub is already connected. Disconnect it first to connect another app.', code: 'already_connected' });
      }

      // GitHub sends the browser back to the address the dashboard is open at, so take it from the request, and only if it is one we accept.
      const origin = req.get('origin');
      const { publicUrl } = await settings.public();
      if (!origin || !(sameOrigin(req, origin) || config.webOrigins.includes(origin) || origin === publicUrl)) {
        return res.status(400).json({ error: 'Open the dashboard in a browser at its own address to connect GitHub' });
      }

      const state = randomBytes(32).toString('base64url');
      req.session.githubConnect = { state, at: Date.now() };
      await save(req);

      const hookBase = publicUrl || origin; // without a public address GitHub cannot deliver yet; the GitHub page offers to fix it later
      const manifest = {
        name: appName,
        url: publicUrl || origin,
        hook_attributes: { url: `${hookBase}/api/webhooks/github`, active: true },
        redirect_url: `${origin}/api/github/connect/callback`,
        public: false,
        default_permissions: { contents: 'read', metadata: 'read' },
        default_events: ['push'],
      };
      const target = owner ? `https://github.com/organizations/${owner}/settings/apps/new` : 'https://github.com/settings/apps/new';
      res.json({ postUrl: `${target}?state=${encodeURIComponent(state)}`, manifest });
    } catch (err) {
      next(err);
    }
  });

  // GitHub redirects the browser here. It is a page navigation, so every outcome is a redirect back to the GitHub page, with a short
  // reason code and nothing else.
  r.get('/callback', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const back = (query) => res.redirect(302, `/github?${query}`);
    try {
      const s = req.session;
      if (!s?.userId || Date.now() - s.createdAt > config.maxLifetimeMs) return back('error=login');
      const pending = s.githubConnect;
      delete s.githubConnect; // used once, whatever happens next
      await save(req);

      const { code, state } = req.query;
      if (!pending || typeof state !== 'string' || !sameText(state, pending.state) || Date.now() - pending.at > STATE_TTL_MS) return back('error=state');
      if (typeof code !== 'string') return back('error=exchange_failed');
      if (await githubAppSummary(db)) return back('error=already_connected');

      let created;
      try {
        created = await exchangeManifestCode(code, { ...(fetch ? { fetch } : {}) });
      } catch (err) {
        return back(err instanceof GithubError && err.status === undefined ? 'error=github_unreachable' : 'error=exchange_failed');
      }
      await saveGithubApp(db, secretsKey, { ...created, source: 'manifest' });
      await forgetInstallations(db);
      provider.invalidate();
      const { rows } = await db.query('SELECT username FROM users WHERE id = $1', [s.userId]);
      await recordAttempt(db, { kind: 'github', username: rows[0]?.username ?? 'admin', address: addressOf(req), success: true });
      return back('connected=1');
    } catch (err) {
      return next(err);
    }
  });

  return r;
}
