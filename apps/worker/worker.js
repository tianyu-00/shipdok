// Worker entry point: pulls deploy jobs off the queue and runs them via processDeployJob().
// One job at a time (concurrency 1) for the Pi.
//
// Run: npm start -w apps/worker      (loads infrastructure/.env, including APP_SECRETS_KEY)
import { Worker } from "bullmq";
import { parseMasterKey } from "@shipdok/shared";
import { reconcile } from "./src/reconcile.js";
import { DEPLOY_QUEUE, redisConnection } from "./src/queue.js";
import * as deployments from "./src/db.js";
import { processDeployJob } from "./src/process-job.js";

// Fail fast, before touching Redis or Docker, if the master key is missing or malformed.
let secretsKey;
try {
  secretsKey = parseMasterKey(process.env.APP_SECRETS_KEY);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const connection = redisConnection();

const worker = new Worker(DEPLOY_QUEUE, (job) => processDeployJob(job, { secretsKey }), {
  connection,
  concurrency: 1,
  maxStalledCount: 0,
  autorun: false,
});

worker.on("ready", () => console.log("Worker ready, waiting for deploy jobs"));
worker.on("completed", (job, res) => console.log(`[job ${job.id}] completed`, res));
worker.on("failed", (job, err) => {
  console.log(`[job ${job?.id}] failed: ${err.message}`);
  // A stalled job never reached our own failure handling; record it here.
  // markFailed only touches rows that are still active, so it cannot overwrite a final status.
  const id = job?.data?.deploymentId;
  if (id && /stalled/i.test(err.message)) {
    deployments.markFailed(id, err.message).catch((e) => console.error(`Could not record stall: ${e.message}`));
  }
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
