// API-side producer for the deploy queue. The queue name and job options must match
// apps/worker/src/queue.js. (TODO: move both into packages/shared once that exists.)
import { Queue } from "bullmq";
import IORedis from "ioredis";

export const DEPLOY_QUEUE = "deploy";

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
    close: async () => {
      await queue.close();
      await connection.quit();
    },
  };
}
