import pg from "pg";
import { pgConfig } from "../src/db/pool.js";

// Hard guard: these helpers truncate tables, so refuse to touch anything but a *_test database.
const config = pgConfig();
if (!config.database?.endsWith("_test")) {
  throw new Error(`Refusing to run tests against database "${config.database}"`);
}

export const testPool = new pg.Pool(config);

// Dynamic import so a test file can set env vars (e.g. SETUP_TOKEN) before config loads.
// A fresh app per call also means fresh in-memory rate limiters.
export async function makeApp({ queue, ...rest } = {}) {
  const { createApp } = await import("../src/app.js");
  // Webhooks need a secret: a fixed one for tests unless the test connects a GitHub App (githubProvider) or gives its own.
  const fixedSecret = rest.githubProvider ? {} : { webhookSecret: process.env.GITHUB_WEBHOOK_SECRET };
  return createApp({ db: testPool, queue, ...fixedSecret, ...rest });
}

export async function resetDb() {
  await testPool.query('TRUNCATE users, deployments, apps, github_apps, "session", webhook_deliveries, login_attempts, settings RESTART IDENTITY CASCADE');
}

export async function closeDb() {
  await testPool.end();
}

export const PASSWORD = "a-long-test-password";

// Fixed public-access settings for a test that does not need the database ones (the tunnel tests use "webhook": real
// clients behind a proxy are outside visitors, who get nothing but the webhook).
export const settingsFor = (mode, publicUrl = "") => ({
  public: async () => ({ mode, publicUrl, modeLocked: false, urlLocked: false }),
  setPublic: async () => {},
  invalidate() {},
});
