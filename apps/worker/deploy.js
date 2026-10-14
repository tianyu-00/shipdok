#!/usr/bin/env node
// Shipdok Step 1 prototype: clone -> build -> candidate -> health check -> swap.
// No API, DB or queue. Keep this logic free of Express/BullMQ so the worker can import it later.
//
// Setup:   npm init -y && npm i dockerode      (Node 18+, Docker running)
// Usage:   node deploy.js --repo https://github.com/tianyu-00/shipdok-test-app.git --ref main \
//            --app shipdok-test-app --container-port 3000 --host-port 8080 --health /health
//
// Public repos only for now (GitHub App tokens come in Milestone 3).

import Docker from "dockerode";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";

const docker = new Docker(); // /var/run/docker.sock

const { values: a } = parseArgs({
  options: {
    repo: { type: "string" },
    ref: { type: "string", default: "main" },
    app: { type: "string" },
    "container-port": { type: "string" },
    "host-port": { type: "string" },
    health: { type: "string" },
    dir: { type: "string", default: "." },
    memory: { type: "string", default: "512" }, // MB
    cpus: { type: "string", default: "1" },
  },
});
for (const k of ["repo", "app", "container-port", "host-port"]) {
  if (!a[k]) {
    console.error(`Missing --${k}`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

// ---- ownership labels: every cleanup query filters on these ----
const deploymentId = randomBytes(4).toString("hex");
const labels = (role) => ({
  "shipdok.managed": "true",
  "shipdok.app-id": a.app,
  "shipdok.deployment-id": deploymentId,
  "shipdok.role": role, // candidate | live
});

async function findLive() {
  const list = await docker.listContainers({
    all: true,
    filters: { label: ["shipdok.managed=true", `shipdok.app-id=${a.app}`, "shipdok.role=live"] },
  });
  return list.map((c) => docker.getContainer(c.Id));
}

async function createContainer({ image, role, hostPort }) {
  const cport = `${a["container-port"]}/tcp`;
  return docker.createContainer({
    Image: image,
    name: `shipdok-${a.app}-${deploymentId}-${role}`,
    Labels: labels(role),
    ExposedPorts: { [cport]: {} },
    HostConfig: {
      PortBindings: { [cport]: [{ HostPort: hostPort }] }, // '' = Docker picks a free port
      Memory: Number(a.memory) * 1024 * 1024,
      NanoCpus: Number(a.cpus) * 1e9,
      RestartPolicy: { Name: "on-failure", MaximumRetryCount: 5 },
      // No privileged, no docker.sock mount, no host binds.
    },
  });
}

async function hostPortOf(container) {
  const info = await container.inspect();
  return info.NetworkSettings.Ports[`${a["container-port"]}/tcp`]?.[0]?.HostPort;
}

// Fail fast on early exit; otherwise poll HTTP until 200 or timeout.
async function waitHealthy(container, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const port = await hostPortOf(container);
  while (Date.now() < deadline) {
    const { State } = await container.inspect();
    if (!State.Running) {
      throw new Error(`Container exited early (code ${State.ExitCode}, OOMKilled=${State.OOMKilled})`);
    }
    if (a.health) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${a.health}`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
    } else {
      // No health path: running for 3s is the weak fallback the spec warns about.
      await sleep(3000);
      if ((await container.inspect()).State.Running) return;
    }
    await sleep(1000);
  }
  throw new Error(`Health check timed out after ${timeoutMs / 1000}s`);
}

async function removeQuietly(c) {
  try {
    await c.remove({ force: true });
  } catch {
    /* already gone */
  }
}

// ---- deployment ----
async function deploy() {
  const workDir = await mkdtemp(join(tmpdir(), "shipdok-"));
  const image = `shipdok/${a.app}:${deploymentId}`;
  let candidate, finalC;
  const previous = await findLive();

  try {
    log(`Cloning ${a.repo}@${a.ref}`);
    await run("git", ["clone", "--depth", "1", "--branch", a.ref, a.repo, workDir]);

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
        `shipdok.app-id=${a.app}`,
        "--label",
        `shipdok.deployment-id=${deploymentId}`,
        join(workDir, a.dir),
      ],
      { env: { ...process.env, DOCKER_BUILDKIT: "1" } },
    );

    // Cheap architecture check (spec: clear error, no emulation)
    const img = await docker.getImage(image).inspect();
    const hostArch = (await docker.info()).Architecture; // aarch64 / x86_64
    log(`Image arch: ${img.Architecture}, host: ${hostArch}`);

    // 1) Candidate on a temporary port; live app untouched
    log("Starting candidate on a temporary port");
    candidate = await createContainer({ image, role: "candidate", hostPort: "" });
    await candidate.start();
    await waitHealthy(candidate);
    log("Candidate healthy");
    await removeQuietly(candidate);
    candidate = null;

    // 2) Swap: stop old (keep it), start final on the real port
    for (const old of previous) await old.stop().catch(() => {});
    try {
      finalC = await createContainer({ image, role: "live", hostPort: a["host-port"] });
      await finalC.start();
      await waitHealthy(finalC);
    } catch (err) {
      log(`Swap failed: ${err.message}. Restoring previous version`);
      if (finalC) await removeQuietly(finalC);
      for (const old of previous) await old.start().catch((e) => log(`RESTORE FAILED: ${e.message}`));
      throw err;
    }

    // 3) Success: retire previous containers (images kept for rollback)
    for (const old of previous) await removeQuietly(old);
    log(`Deployed ${a.app} (${deploymentId}) on :${a["host-port"]}`);
  } catch (err) {
    log(`Deployment FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (candidate) await removeQuietly(candidate);
    await rm(workDir, { recursive: true, force: true });
  }
}

deploy();
