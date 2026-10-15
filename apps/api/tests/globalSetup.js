// Runs once before all tests: create the *_test database if missing, then migrate it.
import pg from "pg";
import { runMigrations } from "../src/db/migrate.js";

export default async function globalSetup() {
  const baseDb = process.env.POSTGRES_DB;
  if (!baseDb) throw new Error("POSTGRES_DB is not set. Run tests with: npm test");
  const testDb = baseDb.endsWith("_test") ? baseDb : `${baseDb}_test`;
  const conn = {
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  };

  const admin = new pg.Client({ ...conn, database: baseDb.replace(/_test$/, "") });
  await admin.connect();
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [testDb]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${testDb}"`);
  await admin.end();

  await runMigrations({ ...conn, database: testDb }, { log: () => {} });
}
