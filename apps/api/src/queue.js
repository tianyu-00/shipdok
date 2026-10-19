import "./loadsecrets.js";
// API-side producer for the deploy queue. The queue name comes from @shipdok/shared so it
// can never drift from the worker's. Job options must match apps/worker/src/queue.js.
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { DEPLOY_QUEUE } from "@shipdok/shared";

export { DEPLOY_QUEUE };

export function createDeployQueue() {
  const connection = new IORedis({
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(DEPLOY_QUEUE, {
    connection,
    // No automatic retries: the administrator retries manually (spec section 7).
    defaultJobOptions: { attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } },
  });
  return {
    add: (name, data) => queue.add(name, data),
    // Drops a job that has not started. A running job cannot be removed (BullMQ throws); callers ignore that.
    remove: async (jobId) => {
      const job = await queue.getJob(jobId);
      if (job) await job.remove();
    },
    close: async () => {
      await queue.close();
      await connection.quit();
    },
  };
}
