// Shared queue settings for the worker and for whatever enqueues jobs.
// The queue name must match apps/api/src/queue.js.
import IORedis from "ioredis";

export const DEPLOY_QUEUE = "deploy";

export function redisConnection() {
  return new IORedis({
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null, // required by BullMQ workers
  });
}

// No automatic retries: the administrator retries manually (see spec section 7).
export const defaultJobOptions = {
  attempts: 1,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};
