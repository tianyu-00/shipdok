// Worker entry point: pulls deploy jobs off the queue and runs deploy().
// One job at a time (concurrency 1) for the Pi.
//
// Run: node --env-file=../../infrastructure/.env worker.js
import { readFile } from "node:fs/promises";
import { Worker } from "bullmq";
import { deploy } from "./src/deploy.js";
import { parseEnvFile } from "./src/docker.js";
import { DEPLOY_QUEUE, redisConnection } from "./src/queue.js";
import { reconcile } from "./src/reconcile.js";

const connection = redisConnection();

const worker = new Worker(
  DEPLOY_QUEUE,
  async (job) => {
    const d = job.data;
    // Prototype only: env comes from a file on disk. The real version decrypts
    // the app's secrets from Postgres here and never puts them in the job payload.
    const env = d.envFile ? parseEnvFile(await readFile(d.envFile, "utf8")) : [];

    const log = (msg) => {
      console.log(`[job ${job.id}] ${msg}`);
      job.log(msg).catch(() => {}); // kept in Redis for now; real log storage comes later
    };

    const result = await deploy({ ...d, env, log });
    if (!result.ok) throw new Error(result.error); // marks the job failed
    return { deploymentId: result.deploymentId, image: result.image };
  },
  { connection, concurrency: 1, maxStalledCount: 0, autorun: false },
);

worker.on("ready", () => console.log("Worker ready, waiting for deploy jobs"));
worker.on("completed", (job, res) => console.log(`[job ${job.id}] completed`, res));
worker.on("failed", (job, err) => console.log(`[job ${job?.id}] failed: ${err.message}`));

await reconcile();
worker.run().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`${signal}: letting the current job finish, then exiting`);
  await worker.close();
  await connection.quit();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
