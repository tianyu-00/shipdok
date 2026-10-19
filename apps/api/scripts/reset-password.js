// Host-side password reset. In Docker:  docker compose -f infrastructure/compose.yaml --env-file infrastructure/.env exec api node scripts/reset-password.js
// From a checkout:  npm run reset-password -w apps/api
import pg from "pg";
import { pgConfig } from "../src/db/pool.js";
import { resetAdminPassword } from "../src/resetpassword.js";

const pool = new pg.Pool(pgConfig());
try {
  const { username, password } = await resetAdminPassword(pool);
  console.log(`The password for "${username}" is now:\n\n  ${password}\n\nEvery session was signed out. Log in with it, then change it on the Security page.\nIt is not stored anywhere else and will not be shown again.`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
