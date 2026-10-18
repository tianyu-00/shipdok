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
  return createApp({ db: testPool, queue, ...rest });
}

export async function resetDb() {
  await testPool.query('TRUNCATE users, deployments, apps, "session", webhook_deliveries RESTART IDENTITY CASCADE');
}

export async function closeDb() {
  await testPool.end();
}

export const PASSWORD = "a-long-test-password";
