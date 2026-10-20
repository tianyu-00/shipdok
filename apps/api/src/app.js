import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config, loadSecretsKey } from './config.js';
import { parsePortRange } from './ports.js';
import { pool } from './db/pool.js';
import { originCheck } from './middleware/originCheck.js';
import { publicAccess, visitorCheck } from './middleware/publicAccess.js';
import { createSettings } from './settings.js';
import { settingsRouter } from './routes/settings.js';
import { requireAuth } from './middleware/requireAuth.js';
import { authRouter } from './routes/auth.js';
import { recoveryRouter } from './routes/recovery.js';
import { appsRouter, deploymentsRouter } from './routes/apps.js';
import { envRouter } from './routes/env.js';
import { webhookReceiver, deliveriesRouter } from './routes/webhooks.js';
import { githubRouter } from './routes/github.js';
import { githubConnectRouter } from './routes/githubconnect.js';
import { createGithubProvider, logRoot } from '@shipdok/shared';
import { deploymentLogsRouter, appLogsRouter, storageRouter } from './routes/logs.js';
import { defaultDiskUsage } from './disk.js';
import { docsGate, docsRouter } from './docs.js';
import { appVolumesRouter, volumesRouter } from './routes/volumes.js';

// What the API asks about GitHub: the client, the webhook secret, a status. Normally read from the database (the app is connected in the
// dashboard); tests can pass a fixed client and secret instead.
function fixedGithub({ github = null, webhookSecret = null }) {
  return {
    client: async () => github,
    webhookSecret: async () => webhookSecret,
    status: async () => ({ app: null, problem: null }),
    invalidate() {},
  };
}

// db, queue and secretsKey are injectable so tests can pass a test pool and a fake queue.
export function createApp({
  db = pool, queue, secretsKey = loadSecretsKey(),
  webhookSecret, webhookRateLimit = 120,
  github, githubProvider, githubFetch,
  logDir = logRoot(), diskUsage = defaultDiskUsage, portRange = parsePortRange(config.portRangeText),
  trustProxy = process.env.TRUST_PROXY || 'loopback',
  settings = createSettings(db),
  apiDocs = config.apiDocs,
} = {}) {
  const provider = githubProvider ?? (github !== undefined || webhookSecret !== undefined
    ? fixedGithub({ github, webhookSecret })
    : createGithubProvider(db, secretsKey, { fetch: githubFetch, onProblem: (err) => console.warn(`Warning: ${err.message}`) }));
  const app = express();
  app.disable('x-powered-by');
  // Believe X-Forwarded-For only when the connection itself comes from a proxy we run: by default this machine (the
  // Cloudflare tunnel's cloudflared). In Docker Compose the dashboard's nginx also sits in front, on a private address, so
  // compose sets TRUST_PROXY=loopback,uniquelocal. Never `true` or a hop count: a directly connected client could then
  // forge its own address.
  app.set('trust proxy', trustProxy);
  app.use(helmet());

  // Who may reach Shipdok from outside (see middleware/publicAccess.js). First of all, before the webhook receiver, the
  // session and everything else; the check the dashboard's web server makes goes ahead of the rule because it IS the rule's answer.
  app.get('/api/_visitor', visitorCheck(settings));
  app.use(publicAccess(settings));

  // The GitHub webhook is public and signature-protected. It is mounted BEFORE the JSON parser, the session
  // and the origin check: it needs the raw bytes to verify the signature, and it has no cookies or Origin.
  app.use('/api/webhooks/github', webhookReceiver({ db, queue, secret: () => provider.webhookSecret(), rateLimitPerMinute: webhookRateLimit, logDir, diskUsage }));

  app.use(express.json({ limit: '100kb' }));

  const PgStore = connectPgSimple(session);
  app.use(session({
    store: new PgStore({ pool: db, tableName: 'session' }),
    name: 'shipdok.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // sliding inactivity timeout: each request renews the cookie
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: config.idleMs },
  }));
  app.use(originCheck(settings));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'database unavailable' });
    }
  });

  if (apiDocs) app.use('/api/docs', docsGate(config.maxLifetimeMs), requireAuth, docsRouter());
  app.use('/api/settings', requireAuth, settingsRouter({ db, settings, provider }));
  app.use('/api/auth', authRouter(db));
  app.use('/api/auth', recoveryRouter(db));
  app.use('/api/apps/:id/env', requireAuth, envRouter({ db, secretsKey }));
  app.use('/api/apps/:id/volumes', requireAuth, appVolumesRouter({ db }));
  app.use('/api/volumes', requireAuth, volumesRouter({ db, queue }));
  app.use('/api/apps', requireAuth, appsRouter({ db, queue, github: () => provider.client(), logDir, diskUsage, portRange }));
  app.use('/api/apps', requireAuth, appLogsRouter({ db, logDir }));
  app.use('/api/github/connect', githubConnectRouter({ db, provider, secretsKey, settings, fetch: githubFetch })); // before the router below: the callback is a page navigation and answers with redirects
  app.use('/api/github', requireAuth, githubRouter({ db, provider, secretsKey, fetch: githubFetch, settings }));
  app.use('/api/deployments', requireAuth, deploymentsRouter({ db, queue, logDir }));
  app.use('/api/deployments', requireAuth, deploymentLogsRouter({ db, logDir }));
  app.use('/api/storage', requireAuth, storageRouter({ db, logDir, diskUsage }));
  app.use('/api/webhooks/deliveries', requireAuth, deliveriesRouter({ db }));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Client errors raised by middleware (bad JSON, oversized body) are 4xx, not server faults.
    const status = err.status ?? err.statusCode;
    if (status >= 400 && status < 500) {
      const messages = { 'entity.parse.failed': 'Invalid JSON', 'entity.too.large': 'Payload too large' };
      return res.status(status).json({ error: messages[err.type] ?? 'Bad request' });
    }
    console.error('Request failed:', err.message); // message only: never log bodies (passwords, secrets)
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
