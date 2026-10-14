// API settings from the environment. Call assertConfig() once at startup.
export const config = {
  host: process.env.API_HOST ?? '127.0.0.1', // loopback by default; widen deliberately
  port: Number(process.env.API_PORT ?? 4000),
  sessionSecret: process.env.SESSION_SECRET,
  // Origins allowed to make state-changing requests (the dashboard's origin(s)).
  webOrigins: (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  setupToken: process.env.SETUP_TOKEN || null, // optional: required on first-run setup if set
  secureCookies: process.env.COOKIE_SECURE === 'true', // set true when served over HTTPS
  idleMs: 30 * 60 * 1000,            // sliding inactivity timeout (spec: exact values open)
  maxLifetimeMs: 12 * 60 * 60 * 1000, // absolute session lifetime
};

export function assertConfig() {
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters (try: openssl rand -hex 32)');
  }
}
