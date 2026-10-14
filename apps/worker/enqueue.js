// Manually enqueue a deploy job (stand-in for the API until it exists).
//
// Run: node --env-file=../../infrastructure/.env enqueue.js --repo <url> --ref main \
//        --app my-app --container-port 3000 --host-port 8080 --health /health \
//        [--dir backend] [--env-file-path /path/outside/repo/app.env]
import { parseArgs } from "node:util";
import { Queue } from "bullmq";
import { DEPLOY_QUEUE, redisConnection, defaultJobOptions } from "./src/queue.js";

const { values: a } = parseArgs({
  options: {
    repo: { type: "string" },
    ref: { type: "string", default: "main" },
    app: { type: "string" },
    "container-port": { type: "string" },
    "host-port": { type: "string" },
    health: { type: "string" },
    dir: { type: "string", default: "." },
    "env-file-path": { type: "string" },
  },
});
for (const k of ["repo", "app", "container-port", "host-port"]) {
  if (!a[k]) {
    console.error(`Missing --${k}`);
    process.exit(2);
  }
}

const connection = redisConnection();
const queue = new Queue(DEPLOY_QUEUE, { connection, defaultJobOptions });
const job = await queue.add("deploy", {
  repo: a.repo,
  ref: a.ref,
  appId: a.app,
  containerPort: a["container-port"],
  hostPort: a["host-port"],
  health: a.health,
  dir: a.dir,
  envFile: a["env-file-path"],
});
console.log(`Enqueued job ${job.id}`);
await connection.quit();
