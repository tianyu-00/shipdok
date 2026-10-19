import "../loadsecrets.js";
// Shared Postgres pool. Settings come from the environment (see .env.example).
import pg from "pg";

export function pgConfig() {
  return {
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  };
}

export const pool = new pg.Pool(pgConfig());
