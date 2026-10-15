// Worker entry point: pulls deploy jobs off the queue, runs deploy(), and records progress
// on the deployment row. One job at a time (concurrency 1) for the Pi.
//
// Run: node --env-file=../../infrastructure/.env worker.js
import { readFile } from "node:fs/promises";
import { Worker } from "bullmq";
import { deploy } from "./src/deploy.js";
import { parseEnvFile } from "./src/docker.js";
import { reconcile } from "./src/reconcile.js";
import { DEPLOY_QUEUE, redisConnection } from "./src/queue.js";
import * as deployments from "./src/db.js";

const connection = redisConnection();

// Status updates are best-effort: a database hiccup must not abort a deployment mid-swap.
const tolerate = (label) => (err) => console.error(`Could not record ${label}: ${err.message}`);

const worker = new Worker(
  DEPLOY_QUEUE,
  async (job) => {
    const d = job.data;
    const id = d.deploymentId; // absent for jobs from the manual enqueue.js script
    // Prototype only: env comes from a file on disk. The real version decrypts
    // the app's secrets from Postgres here and never puts them in the job payload.
    const env = d.envFile ? parseEnvFile(await readFile(d.envFile, "utf8")) : [];

    const log = (msg) => {
      console.log(`[job ${job.id}] ${msg}`);
      job.log(msg).catch(() => {}); // kept in Redis for now; real log storage comes later
    };

    if (id) await deployments.markBuilding(id).catch(tolerate("building"));

    const result = await deploy({
      ...d,
      env,
      log,
      onStatus: id ? (s) => deployments.setStatus(id, s).catch(tolerate(s)) : undefined,
      onCommit: id ? (sha) => deployments.setCommit(id, sha).catch(tolerate("commit")) : undefined,
    });

    if (id) {
      if (result.ok) await deployments.markSucceeded(id, result.image).catch(tolerate("success"));
      else await deployments.markFailed(id, result.error).catch(tolerate("failure"));
    }

    if (!result.ok) throw new Error(result.error); // marks the job failed
    return { deploymentId: result.deploymentId, image: result.image };
  },
  { connection, concurrency: 1, maxStalledCount: 0, autorun: false },
);

worker.on("ready", () => console.log("Worker ready, waiting for deploy jobs"));
worker.on("completed", (job, res) => console.log(`[job ${job.id}] completed`, res));
worker.on("failed", (job, err) => {
  console.log(`[job ${job?.id}] failed: ${err.message}`);
  // A stalled job never reached our own failure handling; record it here.
  // markFailed only touches rows that are still active, so it cannot overwrite a final status.
  const id = job?.data?.deploymentId;
  if (id && /stalled/i.test(err.message)) deployments.markFailed(id, err.message).catch(tolerate("stall"));
});

async function shutdown(signal) {
  console.log(`${signal}: letting the current job finish, then exiting`);
  await worker.close();
  await connection.quit();
  await deployments.pool.end();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await reconcile();
worker.run().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});
