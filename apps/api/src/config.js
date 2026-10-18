import { parseMasterKey } from "@shipdok/shared";

// API settings from the environment. Call assertConfig() once at startup.
export const config = {
  host: process.env.API_HOST ?? "127.0.0.1", // loopback by default; widen deliberately
  port: Number(process.env.API_PORT ?? 4000),
  sessionSecret: process.env.SESSION_SECRET,
  // Origins allowed to make state-changing requests (the dashboard's origin(s)).
  webOrigins: (process.env.WEB_ORIGIN ?? "http://localhost:5173").split(",").map((s) => s.trim()),
  setupToken: process.env.SETUP_TOKEN || null, // optional: required on first-run setup if set
  // Shared secret GitHub signs webhooks with. Unset = the webhook endpoint is disabled.
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || null,
  secureCookies: process.env.COOKIE_SECURE === "true", // set true when served over HTTPS
  idleMs: 30 * 60 * 1000, // sliding inactivity timeout (spec: exact values open)
  maxLifetimeMs: 12 * 60 * 60 * 1000, // absolute session lifetime
};

// The master key for encrypting app secrets. Throws a clear error if missing or malformed.
export function loadSecretsKey() {
  return parseMasterKey(process.env.APP_SECRETS_KEY);
}

export function assertConfig() {
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters (try: openssl rand -hex 32)");
  }
  loadSecretsKey();
  if (config.webhookSecret && config.webhookSecret.length < 16) {
    throw new Error("GITHUB_WEBHOOK_SECRET must be at least 16 characters (try: openssl rand -hex 32)");
  }
}
