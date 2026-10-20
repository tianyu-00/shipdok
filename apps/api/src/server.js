import { assertConfig, config } from "./config.js";
import { createApp } from "./app.js";
import { createDeployQueue } from "./queue.js";
import { oldGithubEnvNotice } from "@shipdok/shared";
import { pool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { setupTokenNotice } from "./setupnotice.js";

assertConfig();
// The database is brought up to date BEFORE anything listens, so the health check only passes once the tables are there
// (the worker waits for it) and a failed migration stops the API with a message instead of serving a half-built database.
try {
  await runMigrations();
} catch (err) {
  console.error(`The database could not be prepared: ${err.message}`);
  process.exit(1);
}
const notice = oldGithubEnvNotice();
if (notice) console.warn(`Warning: ${notice}`);
const queue = createDeployQueue();
const server = createApp({ queue }).listen(config.port, config.host, async () => {
  console.log(`API listening on http://${config.host}:${config.port}`);
  try {
    const { rows } = await pool.query("SELECT EXISTS (SELECT 1 FROM users) AS has_admin");
    const text = setupTokenNotice({ token: config.setupToken, hasAdmin: rows[0].has_admin });
    if (text) console.log(`\n${text}\n`);
  } catch {
    /* the database is not reachable yet: the next start prints it */
  }
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  server.close();
  await queue.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
