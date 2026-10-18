import { parseMasterKey, encryptSecret, envVarContext } from "@shipdok/shared";
import { pool } from "../src/db.js";

// Hard guard: these helpers truncate tables, so refuse anything but a *_test database.
if (!process.env.POSTGRES_DB?.endsWith("_test")) {
  throw new Error(`Refusing to run tests against database "${process.env.POSTGRES_DB}"`);
}

export { pool };
export const KEY = parseMasterKey(process.env.APP_SECRETS_KEY);
export const OTHER_KEY = parseMasterKey("b2".repeat(32));
export const SECRET = "S3cr3t-Value-Do-Not-Leak-9f2a";

// The API's test run creates and migrates the *_test database; the worker tests reuse it.
export async function ready() {
  try {
    const { rows } = await pool.query(`SELECT 1 FROM schema_migrations WHERE name = '007_app_runtime.sql'`);
    if (rows.length) return;
  } catch {
    /* fall through to the hint */
  }
  throw new Error("The test database is missing or not migrated. Run the API tests first: npm test -w apps/api");
}

export async function reset() {
  await pool.query("TRUNCATE deployments, apps RESTART IDENTITY CASCADE");
}

let n = 0;
export async function makeApp() {
  n += 1;
  const { rows } = await pool.query(
    `INSERT INTO apps (name, slug, repo, container_port, host_port)
     VALUES ($1, $1, 'o/r', 3000, $2) RETURNING id`,
    [`app-${n}`, 30000 + n],
  );
  return rows[0].id;
}

export async function addVar(appId, name, value, key = KEY) {
  await pool.query("INSERT INTO app_env_vars (app_id, key, value_encrypted) VALUES ($1, $2, $3)", [
    appId,
    name,
    encryptSecret(value, key, envVarContext(appId, name)),
  ]);
}

export async function makeDeployment(appId, snapshot = {}) {
  const { rows } = await pool.query(
    `INSERT INTO deployments (app_id, trigger, config_snapshot) VALUES ($1, 'manual', $2) RETURNING id`,
    [appId, snapshot],
  );
  return rows[0].id;
}

export const getDeployment = async (id) => (await pool.query("SELECT * FROM deployments WHERE id = $1", [id])).rows[0];

export const versionsOf = async (appId) =>
  Object.fromEntries(
    (await pool.query("SELECT key, version::text AS version FROM app_env_vars WHERE app_id = $1", [appId])).rows.map(
      (r) => [r.key, r.version],
    ),
  );
