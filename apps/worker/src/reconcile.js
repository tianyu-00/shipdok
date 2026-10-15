// Startup reconciliation: remove what a crashed worker left behind.
// Safe ONLY while a single worker runs one job at a time: at boot, no candidate
// container, temp clone or in-progress deployment can legitimately be in use.
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, LABEL, removeQuietly } from "./docker.js";
import { interruptActive } from "./db.js";

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

  log(
    `Reconcile done: ${report.candidatesRemoved} candidate(s), ${report.tempDirsRemoved} temp dir(s), ${report.deploymentsInterrupted} deployment(s) interrupted`,
  );
  return report;
}
