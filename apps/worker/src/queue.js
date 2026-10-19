import "./loadsecrets.js";
// Shared queue settings for the worker and for whatever enqueues jobs.
// The queue name comes from @shipdok/shared so it can never drift from the API's.
import IORedis from "ioredis";
import { DEPLOY_QUEUE } from "@shipdok/shared";

export { DEPLOY_QUEUE };

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
