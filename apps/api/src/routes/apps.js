import { Router } from "express";
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === "string" && UUID_RE.test(s);

export const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

// Root directory: relative, no traversal. (deploy() re-checks this defensively.)
const rootDir = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._\/-]+$/, "Use letters, numbers, dot, dash, underscore and slash")
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "Must be a relative path inside the repository");

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use GitHub owner/repo"),
    branch: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_][A-Za-z0-9._\/-]{0,254}$/, "Invalid branch name")
      .default("main"),
    root_dir: rootDir.default("."),
    container_port: z.number().int().min(1).max(65535),
    // Required for now; race-safe auto-allocation is a later milestone item.
    host_port: z.number().int().min(1024).max(65535),
    health_path: z
      .string()
      .regex(/^\/[^\s]*$/, "Must start with / and contain no spaces")
      .max(200)
      .nullish(),
    memory_mb: z.number().int().min(64).max(8192).default(512),
    cpus: z.number().min(0.1).max(4).default(1),
  })
  .strict();

const UNIQUE_MESSAGES = {
  apps_name_key: "An app with this name already exists",
  apps_slug_key: "An app with a matching name already exists",
  apps_host_port_key: "That host port is already assigned to another app",
};

const DEPLOYMENT_COLUMNS = `id, app_id, commit_sha, trigger, status, image_ref, config_snapshot,
  error_summary, job_id, queued_at, started_at, finished_at`;

export function appsRouter({ db, queue }) {
  const r = Router();

  r.post("/", async (req, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({
            error: "Invalid app settings",
            details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
      }
      const a = parsed.data;
      const slug = slugify(a.name);
      if (!slug) return res.status(400).json({ error: "Name must contain letters or numbers" });

      try {
        const { rows } = await db.query(
          `INSERT INTO apps (name, slug, repo, branch, root_dir, container_port, host_port, health_path, memory_mb, cpus)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            a.name,
            slug,
            a.repo,
            a.branch,
            a.root_dir,
            a.container_port,
            a.host_port,
            a.health_path ?? null,
            a.memory_mb,
            a.cpus,
          ],
        );
        res.status(201).json(rows[0]);
      } catch (err) {
        if (err.code === "23505")
          return res.status(409).json({ error: UNIQUE_MESSAGES[err.constraint] ?? "App already exists" });
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  r.get("/", async (req, res, next) => {
    try {
      const { rows } = await db.query(`
        SELECT a.*,
          (SELECT row_to_json(x) FROM (
             SELECT id, status, commit_sha, queued_at, finished_at FROM deployments
             WHERE app_id = a.id ORDER BY queued_at DESC LIMIT 1) x) AS latest_deployment
        FROM apps a ORDER BY a.created_at DESC`);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  r.get("/:id", async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "App not found" });
      const { rows } = await db.query("SELECT * FROM apps WHERE id = $1", [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: "App not found" });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  r.get("/:id/deployments", async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "App not found" });
      const { rows } = await db.query(
        `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE app_id = $1 ORDER BY queued_at DESC LIMIT 50`,
        [req.params.id],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // Request a deployment: persist the row FIRST, then enqueue. If enqueueing fails the
  // row is marked failed so history never shows a deployment that no worker knows about.
  r.post("/:id/deployments", async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "App not found" });
      const { rows: appRows } = await db.query("SELECT * FROM apps WHERE id = $1", [req.params.id]);
      const app = appRows[0];
      if (!app) return res.status(404).json({ error: "App not found" });
      if (!queue) return res.status(503).json({ error: "Deployment queue unavailable" });

      // The settings THIS deployment will use. No secret values belong here.
      const snapshot = {
        repo: app.repo,
        branch: app.branch,
        root_dir: app.root_dir,
        container_port: app.container_port,
        host_port: app.host_port,
        health_path: app.health_path,
        memory_mb: app.memory_mb,
        cpus: Number(app.cpus),
      };
      // Which variable versions this deployment is meant to use (names and numbers only, never values).
      const { rows: envRows } = await db.query(
        "SELECT key, version::text AS version FROM app_env_vars WHERE app_id = $1",
        [app.id],
      );
      snapshot.env = Object.fromEntries(envRows.map((r) => [r.key, r.version]));
      const { rows } = await db.query(
        `INSERT INTO deployments (app_id, trigger, config_snapshot) VALUES ($1, 'manual', $2) RETURNING id`,
        [app.id, snapshot],
      );
      const deploymentId = rows[0].id;

      try {
        const job = await queue.add("deploy", {
          deploymentId,
          appId: app.id,
          slug: app.slug,
          repo: `https://github.com/${snapshot.repo}.git`,
          ref: snapshot.branch,
          dir: snapshot.root_dir,
          containerPort: snapshot.container_port,
          hostPort: snapshot.host_port,
          health: snapshot.health_path ?? undefined,
          memoryMb: snapshot.memory_mb,
          cpus: snapshot.cpus,
        });
        await db.query("UPDATE deployments SET job_id = $2 WHERE id = $1", [deploymentId, String(job.id)]);
      } catch (err) {
        console.error("Enqueue failed:", err.message);
        await db.query(
          `UPDATE deployments SET status = 'failed', finished_at = now(), error_summary = $2 WHERE id = $1`,
          [deploymentId, "Could not enqueue the deployment job"],
        );
        return res.status(503).json({ error: "Could not enqueue the deployment job", deploymentId });
      }

      const { rows: out } = await db.query(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = $1`, [
        deploymentId,
      ]);
      res.status(202).json(out[0]);
    } catch (err) {
      next(err);
    }
  });

  return r;
}

export function deploymentsRouter({ db }) {
  const r = Router();
  r.get("/:id", async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Deployment not found" });
      const { rows } = await db.query(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: "Deployment not found" });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });
  return r;
}
