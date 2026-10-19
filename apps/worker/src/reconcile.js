// Startup reconciliation: remove what a crashed worker left behind.
// Safe ONLY while a single worker runs one job at a time: at boot, no candidate
// container, temp clone or in-progress deployment can legitimately be in use.
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, LABEL, removeQuietly } from "./docker.js";
import * as store from "./db.js";
import { interruptActive } from "./db.js";
import { logRoot, logFilePath, logDirFor, removeDeploymentLogs } from "@shipdok/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUR_FILES = new Set(["build.log", "runtime.log"]);

// Tidies the log directory at boot. (1) Build logs a dead worker never closed get their real size. (2) The logs of
// deployments that no longer exist are removed: a deployment's logs live exactly as long as the deployment does.
// It only ever touches UUID-named directories that contain nothing but our own two log files.
export async function reconcileLogs(root, { db = store, log = console.log } = {}) {
  const report = { logsClosed: 0, orphansRemoved: 0 };

  for (const { deploymentId, appId } of await db.listOpenBuildLogs()) {
    let bytes = 0;
    try { bytes = (await stat(logFilePath(root, appId, deploymentId, "build"))).size; } catch { /* never written */ }
    await db.closeLogFile(deploymentId, "build", { bytes, truncated: false });
    report.logsClosed++;
  }

  let appDirs;
  try { appDirs = await readdir(root); } catch { return report; } // no log directory yet: nothing to tidy
  const found = []; // { appId, deploymentId }
  for (const appId of appDirs.filter((n) => UUID_RE.test(n))) {
    let deployments = [];
    try { deployments = await readdir(join(root, appId)); } catch { continue; }
    for (const deploymentId of deployments.filter((n) => UUID_RE.test(n))) found.push({ appId, deploymentId });
  }
  const alive = await db.existingDeploymentIds(found.map((f) => f.deploymentId));
  for (const { appId, deploymentId } of found) {
    if (alive.has(deploymentId)) continue;
    const names = await readdir(logDirFor(root, appId, deploymentId)).catch(() => null);
    if (!names || names.some((n) => !OUR_FILES.has(n))) continue; // not purely ours: leave it alone
    const freed = await removeDeploymentLogs(root, appId, deploymentId);
    report.orphansRemoved++;
    log(`Reconcile: removed the logs of deployment ${deploymentId}, which no longer exists (${freed} bytes)`);
  }
  return report;
}

export async function reconcile(log = console.log) {
  const report = { candidatesRemoved: 0, tempDirsRemoved: 0, deploymentsInterrupted: 0 };

  // 1. Orphaned candidate containers. Scoped by ownership label AND role;
  //    live containers are never touched.
  const candidates = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL.managed}=true`, `${LABEL.role}=candidate`] },
  });
  for (const c of candidates) {
    const name = c.Names?.[0] ?? c.Id.slice(0, 12);
    await removeQuietly(docker.getContainer(c.Id));
    report.candidatesRemoved++;
    log(`Reconcile: removed orphaned candidate ${name}`);
  }

  // 2. Leftover clone directories. Exact pattern from mkdtemp('shipdok-' + 6 chars).
  const base = tmpdir();
  for (const entry of await readdir(base)) {
    if (/^shipdok-[A-Za-z0-9]{6}$/.test(entry)) {
      await rm(join(base, entry), { recursive: true, force: true });
      report.tempDirsRemoved++;
      log(`Reconcile: removed leftover temp dir ${join(base, entry)}`);
    }
  }

  // 3. Deployments the dead worker left mid-flight become 'interrupted' (never silently retried).
  //    'queued' rows are untouched: their jobs are still in Redis and will run.
  report.deploymentsInterrupted = await interruptActive();
  if (report.deploymentsInterrupted)
    log(`Reconcile: marked ${report.deploymentsInterrupted} deployment(s) interrupted`);

  // 4. Log files.
  const logs = await reconcileLogs(logRoot(), { log });
  Object.assign(report, logs);
  if (logs.logsClosed) log(`Reconcile: closed ${logs.logsClosed} unfinished build log(s)`);

  log(
    `Reconcile done: ${report.candidatesRemoved} candidate(s), ${report.tempDirsRemoved} temp dir(s), ${report.deploymentsInterrupted} deployment(s) interrupted`,
  );
  return report;
}
