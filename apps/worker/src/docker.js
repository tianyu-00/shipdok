// Docker helpers. No arg parsing, no process.exit, no knowledge of Express or BullMQ.
import Docker from "dockerode";
import { spawn } from "node:child_process";
import { LABEL } from "@shipdok/shared";

export const docker = new Docker(); // /var/run/docker.sock: treat as highly privileged

// Ownership labels live in @shipdok/shared so the API and worker agree on them.
export { LABEL };

export const abortError = () => Object.assign(new Error("Operation aborted"), { name: "AbortError" });
export const isAbort = (err) => err?.name === "AbortError";

// Sleep that ends early (rejecting with AbortError) if the signal fires.
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function labelsFor({ appId, deploymentId, role }) {
  return {
    [LABEL.managed]: "true",
    [LABEL.app]: appId,
    [LABEL.deployment]: deploymentId,
    [LABEL.role]: role,
  };
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // opts.signal: aborting kills the child with SIGINT and rejects with an AbortError.
    const p = spawn(cmd, args, { stdio: "inherit", killSignal: "SIGINT", ...opts });
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

// Run a command and return its trimmed stdout (for short outputs like a commit SHA).
export function capture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"], ...opts });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exited ${c}`))));
  });
}

export async function findContainers({ appId, role }) {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL.managed}=true`, `${LABEL.app}=${appId}`, `${LABEL.role}=${role}`] },
  });
  return list.map((c) => docker.getContainer(c.Id));
}

export function containerSpec({ image, name, labels, containerPort, hostPort, memoryMb, cpus, env }) {
  const cport = `${containerPort}/tcp`;
  return {
    Image: image,
    name,
    Labels: labels,
    Env: env,
    ExposedPorts: { [cport]: {} },
    HostConfig: {
      PortBindings: { [cport]: [{ HostPort: String(hostPort) }] }, // '' = Docker picks a free port
      Memory: memoryMb * 1024 * 1024,
      NanoCpus: cpus * 1e9,
      // Docker's own restart policy is off: the monitor (monitor.js) decides whether and when to restart, so that
      // crashes are counted, limited and shown, and a reboot is handled the same way as a crash.
      RestartPolicy: { Name: "no" },
      // No privileged mode, no docker.sock, no host binds.
    },
  };
}

export const createContainer = (opts) => docker.createContainer(containerSpec(opts));

// Containers made before the monitor existed still carry Docker's old policy; switch them so Docker and the
// monitor never both restart the same container.
export const setRestartPolicyNone = (container) => container.update({ RestartPolicy: { Name: "no" } });

// Docker answers 304 when a container is already in the state you asked for. For stop and start that is success.
const alreadyThere = (err) => err?.statusCode === 304;
const STOP_GRACE_SECONDS = 10; // time for the app to shut down on SIGTERM before Docker kills it

export async function stopContainer(container) {
  try { await container.stop({ t: STOP_GRACE_SECONDS }); } catch (err) { if (!alreadyThere(err)) throw err; }
}

export async function startContainer(container) {
  try { await container.start(); } catch (err) { if (!alreadyThere(err)) throw err; }
}

export const restartContainer = (container) => container.restart({ t: STOP_GRACE_SECONDS });

export async function isRunning(container) {
  return (await container.inspect()).State.Running === true;
}

export async function hostPortOf(container, containerPort) {
  const info = await container.inspect();
  return info.NetworkSettings.Ports[`${containerPort}/tcp`]?.[0]?.HostPort;
}

// Where the worker probes a candidate. On the host that is loopback; in compose set HEALTH_CHECK_HOST to
// host.docker.internal (loopback there would be the worker's own container). It ends up inside a URL, so keep it a plain hostname.
const HEALTH_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
export function healthUrl(port, path) {
  const host = process.env.HEALTH_CHECK_HOST || '127.0.0.1';
  if (!HEALTH_HOST_RE.test(host)) throw new Error('HEALTH_CHECK_HOST must be a plain hostname or IPv4 address');
  return `http://${host}:${port}${path}`;
}

// What the monitor needs to know about a container, from one inspect.
export async function containerFacts(container) {
  const info = await container.inspect();
  const ended = Date.parse(info.State.FinishedAt);
  return {
    status: info.State.Status,
    exitCode: info.State.ExitCode,
    oomKilled: info.State.OOMKilled === true,
    // Docker reports "0001-01-01..." for a container that has not ended; that is "no end time".
    finishedAt: Number.isFinite(ended) && ended > Date.parse("2000-01-01") ? ended : null,
    restartPolicy: info.HostConfig?.RestartPolicy?.Name ?? "",
  };
}

// One health check, no waiting and no retries: true only for a 2xx answer within the timeout.
export async function probeHealth(container, { containerPort, health }, { timeoutMs = 2000 } = {}) {
  try {
    const port = await hostPortOf(container, containerPort);
    const res = await fetch(healthUrl(port, health), { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

// How did a container that has exited die? Docker's event log knows: `docker stop` and `docker kill` produce a "kill"
// (and "stop") event before "die", while a process that dies on its own produces only "die" (and "oom" when the kernel
// killed it for memory). Exit codes cannot tell these apart (a graceful stop and a clean exit are both 0).
//   'outside'  stopped through the Docker API, not by the app itself
//   'crash'    the process ended by itself
//   'unknown'  no record of the exit (the log is kept in memory, so it is gone after a daemon or host restart)
export function classifyEvents(events) {
  const actions = events.map((e) => e.Action ?? e.status);
  if (!actions.includes("die")) return "unknown";
  return actions.includes("kill") || actions.includes("stop") ? "outside" : "crash";
}

export async function deathCause(container, finishedAtMs, { docker: client = docker, timeoutMs = 5000 } = {}) {
  const events = [];
  let timer;
  try {
    const since = Math.floor(finishedAtMs / 1000) - 5; // the kill event comes just before the die
    const until = Math.ceil(Date.now() / 1000) + 1;
    const stream = await client.getEvents({
      since, until, filters: { container: [container.id], event: ["kill", "stop", "die", "oom"] },
    });
    await new Promise((resolve) => {
      timer = setTimeout(() => { stream.destroy?.(); resolve(); }, timeoutMs);
      let buffer = "";
      stream.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) { try { events.push(JSON.parse(line)); } catch { /* not an event */ } }
      });
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", resolve);
    });
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
  return classifyEvents(events);
}

// Fail fast if the container exits; otherwise poll HTTP until 200 or timeout.
export async function waitHealthy(container, { containerPort, health, timeoutMs = 120_000, signal }) {
  const deadline = Date.now() + timeoutMs;
  const port = await hostPortOf(container, containerPort);
  const url = health ? healthUrl(port, health) : null; // before the loop: a bad HEALTH_CHECK_HOST must fail loudly, not look like "not up yet"
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    const { State } = await container.inspect();
    if (!State.Running) {
      throw new Error(`Container exited early (code ${State.ExitCode}, OOMKilled=${State.OOMKilled})`);
    }
    if (health) {
      try {
        const timeout = AbortSignal.timeout(2000);
        const res = await fetch(url, {
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
        if (res.ok) return;
      } catch {
        if (signal?.aborted) throw abortError();
        /* not up yet */
      }
    } else {
      // Weak fallback: still running after 3s does not prove readiness.
      await sleep(3000, signal);
      if ((await container.inspect()).State.Running) return;
    }
    await sleep(1000, signal);
  }
  throw new Error(`Health check timed out after ${timeoutMs / 1000}s`);
}

// Mask any env value that appears in container output.
export function redact(text, env = []) {
  let t = text;
  for (const kv of env) {
    const v = kv.slice(kv.indexOf("=") + 1);
    if (v.length >= 4) t = t.split(v).join("***");
  }
  return t;
}

// Last N lines of container output. Non-TTY logs are multiplexed (8-byte header per frame).
export async function tailLogs(container, env = [], n = 40) {
  try {
    const buf = await container.logs({ stdout: true, stderr: true, tail: n });
    let out = "";
    let i = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      out += buf.subarray(i + 8, i + 8 + size).toString("utf8");
      i += 8 + size;
    }
    return redact(out.trim(), env);
  } catch {
    return "(could not read container logs)";
  }
}

// Remove an image that will never be used (a cancelled or superseded build). Ignored if it is gone or in use.
export async function removeImage(image) {
  try {
    await docker.getImage(image).remove({ force: false });
  } catch {
    /* already gone, or in use */
  }
}

export async function imageArch(image) {
  return (await docker.getImage(image).inspect()).Architecture;
}

export async function hostArchitecture() {
  return (await docker.info()).Architecture;
}

export async function removeQuietly(c) {
  try {
    await c.remove({ force: true });
  } catch {
    /* already gone */
  }
}

// KEY=VALUE lines -> ['KEY=VALUE', ...]
export function parseEnvFile(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out.push(`${m[1]}=${v}`);
  }
  return out;
}
