import './src/loadsecrets.js'; // first: later imports read the secrets from the environment
// Worker entry point: pulls deploy jobs off the queue and runs them via processDeployJob().
// One job at a time (concurrency 1) for the Pi.
//
// Run: npm start -w apps/worker      (loads infrastructure/.env, including APP_SECRETS_KEY)
import { Worker } from 'bullmq';
import { parseMasterKey, createGithubProvider, oldGithubEnvNotice, logRoot } from '@shipdok/shared';
import { reconcile } from './src/reconcile.js';
import { DEPLOY_QUEUE, redisConnection } from './src/queue.js';
import * as deployments from './src/db.js';
import { processDeployJob } from './src/process-job.js';
import { processControlJob } from './src/control.js';
import { processPruneJob } from './src/prune.js';
import { processDeleteJob } from './src/deleteapp.js';
import { processRemoveVolumeJob } from './src/removevolume.js';
import { processCleanCacheJob, createCacheSampler } from './src/buildcache.js';
import { createVolumeMeasurer } from './src/volumesize.js';
import { createBackupRunner } from './src/backuprunner.js';
import { readVersion } from './src/version.js';
import { jobProcessor } from './src/dispatch.js';
import { createActivity } from './src/activity.js';
import { createMonitor } from './src/monitor.js';
import { createSampler } from './src/stats.js';
import { createCollector } from './src/runtimelog.js';
import { loadAppEnv } from './src/envvars.js';
import * as dockerEngine from './src/docker.js';

// Fail fast, before touching Redis or Docker, if the master key is missing or malformed.
let secretsKey;
try {
  secretsKey = parseMasterKey(process.env.APP_SECRETS_KEY);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// GitHub App (optional): lets the worker clone private repositories. It is connected in the dashboard and stored encrypted in the
// database, so it is read when a job needs it (cached for a few seconds), not at startup. Without it, only public repositories.
if (oldGithubEnvNotice()) console.warn(`Warning: ${oldGithubEnvNotice()}`);
const githubProvider = createGithubProvider(deployments.pool, secretsKey, {
  onProblem: (err) => console.warn(`Warning: ${err.message}`),
});

const connection = redisConnection();
const activity = createActivity(); // which apps a job is working on; the monitor leaves those alone
// The app's own output, saved per app (runtime.log, reset on every restart or new deployment; the run before is kept). Secrets are
// masked with the app's current variable values; if they cannot be read, nothing is collected for that app.
const collector = createCollector({
  root: logRoot(),
  db: deployments,
  eng: dockerEngine,
  loadSecrets: async (appId) => (await loadAppEnv(deployments.pool, appId, secretsKey)).env.map((kv) => kv.slice(kv.indexOf('=') + 1)),
});
const monitor = createMonitor({ activity, collector, intervalMs: Number(process.env.MONITOR_INTERVAL_MS) || 15_000 });

const sampler = createSampler({ intervalMs: Number(process.env.STATS_INTERVAL_MS) || 15_000 }); // CPU and memory of running apps

const cacheSampler = createCacheSampler(); // size of Docker's build cache

const volumeMeasurer = createVolumeMeasurer(); // sizes of the persistent volumes, measured when the administrator asks

const backups = createBackupRunner({ secretsKey, version: readVersion() }); // backups of Shipdok itself: asked for in the dashboard or by the schedule

const worker = new Worker(
  DEPLOY_QUEUE,
  jobProcessor({
    activity,
    deploy: (job) => processDeployJob(job, { secretsKey, github: (githubAppId) => githubProvider.client(githubAppId), collector }),
    control: (job) => processControlJob(job),
    prune: (job) => processPruneJob(job),
    deleteApp: (job) => processDeleteJob(job, { collector }),
    removeVolume: (job) => processRemoveVolumeJob(job),
    cleanCache: (job) => processCleanCacheJob(job),
  }),
  { connection, concurrency: 1, maxStalledCount: 0, autorun: false },
);

worker.on('ready', () => console.log('Worker ready, waiting for deploy jobs'));
worker.on('completed', (job, res) => console.log(`[job ${job.id}] completed`, res));
worker.on('failed', (job, err) => {
  console.log(`[job ${job?.id}] failed: ${err.message}`);
  // A stalled job never reached our own failure handling; record it here.
  // markFailed only touches rows that are still active, so it cannot overwrite a final status.
  // A deletion that stalled (the worker died in the middle of it) never reached its own error handling either: tell the app,
  // so the dashboard offers a retry instead of showing "Deleting…" for ever.
  if (job?.name === 'deleteapp' && job.data?.appId && /stalled/i.test(err.message)) {
    deployments.setDeleteError(job.data.appId, err.message).catch((e) => console.error(`Could not record stall: ${e.message}`));
  }
  const id = job?.data?.deploymentId;
  if (id && /stalled/i.test(err.message)) {
    deployments.markFailed(id, err.message).catch((e) => console.error(`Could not record stall: ${e.message}`));
  }
});

async function shutdown(signal) {
  console.log(`${signal}: letting the current job finish, then exiting`);
  await monitor.stop();
  await sampler.stop();
  await cacheSampler.stop();
  await volumeMeasurer.stop();
  await backups.stop();
  await collector.stopAll(); // close every runtime log and record its size
  await worker.close();
  await connection.quit();
  await deployments.pool.end();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await reconcile();
sampler.start();
cacheSampler.start();
volumeMeasurer.start();
backups.start();
monitor.start(); // crashes, health, and recovery after a host or Docker restart
worker.run().catch((err) => {
  console.error('Worker crashed:', err);
  process.exit(1);
});
