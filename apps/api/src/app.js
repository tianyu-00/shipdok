import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config, loadSecretsKey } from './config.js';
import { pool } from './db/pool.js';
import { originCheck } from './middleware/originCheck.js';
import { requireAuth } from './middleware/requireAuth.js';
import { authRouter } from './routes/auth.js';
import { appsRouter, deploymentsRouter } from './routes/apps.js';
import { envRouter } from './routes/env.js';
import { webhookReceiver, deliveriesRouter } from './routes/webhooks.js';
import { githubRouter } from './routes/github.js';
import { loadGithubAppConfig, createGithubClient, logRoot } from '@shipdok/shared';
import { deploymentLogsRouter, appLogsRouter, storageRouter } from './routes/logs.js';
import { defaultDiskUsage } from './disk.js';

// The GitHub App client exists only when GITHUB_APP_ID and a private key are configured.
function defaultGithub() {
  const cfg = loadGithubAppConfig();
  if (!cfg) return null;
  cfg.warnings.forEach((w) => console.warn(`Warning: ${w}`));
  return createGithubClient(cfg);
}

// db, queue and secretsKey are injectable so tests can pass a test pool and a fake queue.
export function createApp({
  db = pool, queue, secretsKey = loadSecretsKey(),
  webhookSecret = config.webhookSecret, webhookRateLimit = 120,
  github = defaultGithub(),
  logDir = logRoot(), diskUsage = defaultDiskUsage,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Believe X-Forwarded-For only when the connection itself comes from this machine (the Cloudflare tunnel's
  // cloudflared). Never `true` or a hop count: a directly connected client could then forge its own address.
  app.set('trust proxy', 'loopback');
  app.use(helmet());

  // The GitHub webhook is public and signature-protected. It is mounted BEFORE the JSON parser, the session
  // and the origin check: it needs the raw bytes to verify the signature, and it has no cookies or Origin.
  app.use('/api/webhooks/github', webhookReceiver({ db, queue, secret: webhookSecret, rateLimitPerMinute: webhookRateLimit, logDir, diskUsage }));

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
  app.use(originCheck);

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'database unavailable' });
    }
  });

  app.use('/api/auth', authRouter(db));
  app.use('/api/apps/:id/env', requireAuth, envRouter({ db, secretsKey }));
  app.use('/api/apps', requireAuth, appsRouter({ db, queue, github, logDir, diskUsage }));
  app.use('/api/apps', requireAuth, appLogsRouter({ db, logDir }));
  app.use('/api/github', requireAuth, githubRouter({ github }));
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
