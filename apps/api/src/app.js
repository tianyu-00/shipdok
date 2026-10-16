import express from "express";
import helmet from "helmet";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { config, loadSecretsKey } from "./config.js";
import { pool } from "./db/pool.js";
import { originCheck } from "./middleware/originCheck.js";
import { requireAuth } from "./middleware/requireAuth.js";
import { authRouter } from "./routes/auth.js";
import { appsRouter, deploymentsRouter } from "./routes/apps.js";
import { envRouter } from "./routes/env.js";

// db, queue and secretsKey are injectable so tests can pass a test pool and a fake queue.
export function createApp({ db = pool, queue, secretsKey = loadSecretsKey() } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "100kb" }));

  const PgStore = connectPgSimple(session);
  app.use(
    session({
      store: new PgStore({ pool: db, tableName: "session" }),
      name: "shipdok.sid",
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true, // sliding inactivity timeout: each request renews the cookie
      cookie: { httpOnly: true, sameSite: "lax", secure: config.secureCookies, maxAge: config.idleMs },
    }),
  );
  app.use(originCheck);

  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "database unavailable" });
    }
  });

  app.use("/api/auth", authRouter(db));
  app.use("/api/apps/:id/env", requireAuth, envRouter({ db, secretsKey }));
  app.use("/api/apps", requireAuth, appsRouter({ db, queue }));
  app.use("/api/deployments", requireAuth, deploymentsRouter({ db, queue }));

  app.use((req, res) => res.status(404).json({ error: "Not found" }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Client errors raised by middleware (bad JSON, oversized body) are 4xx, not server faults.
    const status = err.status ?? err.statusCode;
    if (status >= 400 && status < 500) {
      const messages = { "entity.parse.failed": "Invalid JSON", "entity.too.large": "Payload too large" };
      return res.status(status).json({ error: messages[err.type] ?? "Bad request" });
    }
    console.error("Request failed:", err.message); // message only: never log bodies (passwords, secrets)
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
