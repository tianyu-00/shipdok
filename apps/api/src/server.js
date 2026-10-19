import { assertConfig, config } from "./config.js";
import { createApp } from "./app.js";
import { createDeployQueue } from "./queue.js";
import { oldGithubEnvNotice } from "@shipdok/shared";

assertConfig();
const notice = oldGithubEnvNotice();
if (notice) console.warn(`Warning: ${notice}`);
const queue = createDeployQueue();
const server = createApp({ queue }).listen(config.port, config.host, () => {
  console.log(`API listening on http://${config.host}:${config.port}`);
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  server.close();
  await queue.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
