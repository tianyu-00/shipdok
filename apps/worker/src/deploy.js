// The deployment itself: clone -> build -> candidate -> health check -> swap.
// Importable by the BullMQ worker. Returns a result object; never calls process.exit.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { assertRelativeDir, resolveBuildDir } from "./paths.js";
import {
  docker,
  labelsFor,
  run,
  capture,
  findContainers,
  createContainer,
  waitHealthy,
  tailLogs,
  removeQuietly,
} from "./docker.js";

/**
 * @param {object} opts
 * @param {string} opts.repo            git clone URL
 * @param {string} opts.appId           stable app ID (used in Docker labels)
 * @param {number|string} opts.containerPort
 * @param {number|string} opts.hostPort
 * @param {string} [opts.deploymentId]  database deployment ID; generated if absent (CLI use)
 * @param {string} [opts.slug]          readable name for image tags and container names
 * @param {string} [opts.ref='main']
 * @param {string} [opts.dir='.']       app root inside the repo
 * @param {string} [opts.health]        HTTP health path, e.g. /health
 * @param {number} [opts.memoryMb=512]
 * @param {number} [opts.cpus=1]
 * @param {string[]} [opts.env=[]]      ['KEY=VALUE', ...]
 * @param {(msg: string) => void} [opts.log]
 * @param {(status: 'starting'|'validating') => void} [opts.onStatus]  progress hook
 * @param {(sha: string) => void} [opts.onCommit]                      resolved commit hook
 * @returns {Promise<{ok: boolean, deploymentId: string, image: string, error?: string}>}
 */
export async function deploy(opts) {
  const o = { ref: "main", dir: ".", memoryMb: 512, cpus: 1, env: [], ...opts };
  const log = o.log ?? ((m) => console.log(`[${new Date().toISOString()}] ${m}`));
  const notify = (fn, ...args) => {
    try {
      fn?.(...args);
    } catch {
      /* hooks must never break a deploy */
    }
  };
  const deploymentId = o.deploymentId ?? randomBytes(4).toString("hex");
  const name = o.slug ?? o.appId;
  const image = `shipdok/${name}:${deploymentId}`;
  const healthOpts = { containerPort: o.containerPort, health: o.health };
  const make = (role, hostPort) =>
    createContainer({
      image,
      name: `shipdok-${name}-${deploymentId}-${role}`,
      labels: labelsFor({ appId: o.appId, deploymentId, role }),
      containerPort: o.containerPort,
      hostPort,
      memoryMb: o.memoryMb,
      cpus: o.cpus,
      env: o.env,
    });

  // Health check that prints container output on failure, before the container is removed.
  const checked = async (container, label) => {
    try {
      await waitHealthy(container, healthOpts);
    } catch (err) {
      const logs = await tailLogs(container, o.env);
      if (logs) log(`--- last container output (${label}) ---\n${logs}\n--- end ---`);
      throw err;
    }
  };

  // Reject an escaping root directory before any side effects (no temp dir, no Docker calls).
  try {
    assertRelativeDir(o.dir);
  } catch (err) {
    log(`Deployment FAILED: ${err.message}`);
    return { ok: false, deploymentId, image, error: err.message };
  }

  const workDir = await mkdtemp(join(tmpdir(), "shipdok-"));
  const previous = await findContainers({ appId: o.appId, role: "live" });
  let candidate;
  let finalC;

  try {
    log(`Cloning ${o.repo}@${o.ref}`);
    await run("git", ["clone", "--depth", "1", "--branch", o.ref, o.repo, workDir]);
    notify(o.onCommit, await capture("git", ["-C", workDir, "rev-parse", "HEAD"]));
    // Resolve symlinks AFTER cloning: the API validates the string, but only the real path is trustworthy.
    const buildDir = await resolveBuildDir(workDir, o.dir);

    log(`Building ${image}`);
    await run(
      "docker",
      [
        "build",
        "-t",
        image,
        "--label",
        "shipdok.managed=true",
        "--label",
        `shipdok.app-id=${o.appId}`,
        "--label",
        `shipdok.deployment-id=${deploymentId}`,
        buildDir,
      ],
      { env: { ...process.env, DOCKER_BUILDKIT: "1" } },
    );

    const img = await docker.getImage(image).inspect();
    const hostArch = (await docker.info()).Architecture;
    log(`Image arch: ${img.Architecture}, host: ${hostArch}`);

    log("Starting candidate on a temporary port");
    notify(o.onStatus, "starting");
    candidate = await make("candidate", "");
    await candidate.start();
    notify(o.onStatus, "validating");
    await checked(candidate, "candidate");
    log("Candidate healthy");
    await removeQuietly(candidate);
    candidate = null;

    for (const old of previous) await old.stop().catch(() => {});
    try {
      finalC = await make("live", o.hostPort);
      await finalC.start();
      await checked(finalC, "live");
    } catch (err) {
      log(`Swap failed: ${err.message}. Restoring previous version`);
      if (finalC) await removeQuietly(finalC);
      for (const old of previous) await old.start().catch((e) => log(`RESTORE FAILED: ${e.message}`));
      throw err;
    }

    for (const old of previous) await removeQuietly(old);
    log(`Deployed ${name} (${deploymentId}) on :${o.hostPort}`);
    return { ok: true, deploymentId, image };
  } catch (err) {
    log(`Deployment FAILED: ${err.message}`);
    return { ok: false, deploymentId, image, error: err.message };
  } finally {
    if (candidate) await removeQuietly(candidate);
    await rm(workDir, { recursive: true, force: true });
  }
}
