// Docker helpers. No arg parsing, no process.exit, no knowledge of Express or BullMQ.
import Docker from "dockerode";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
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
  const { sink, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    // opts.signal: aborting kills the child with SIGINT and rejects with an AbortError.
    // opts.sink: also receives everything the command prints (the deployment's log). It still shows on the console.
    const p = spawn(cmd, args, { stdio: sink ? ["ignore", "pipe", "pipe"] : "inherit", killSignal: "SIGINT", ...spawnOpts });
    if (sink) {
      p.stdout.on("data", (d) => { process.stdout.write(d); sink.write("stdout", d); });
      p.stderr.on("data", (d) => { process.stderr.write(d); sink.write("stderr", d); });
    }
    p.on("error", reject);
    // "close" (not "exit") waits until the output pipes are drained, so the last lines are never lost.
    p.on(sink ? "close" : "exit", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
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

// ---- Backups of Shipdok itself (backup.js). The database is dumped by the Postgres container's own pg_dump, through `docker exec`, with its own environment
// (POSTGRES_USER, POSTGRES_DB), so nothing needs the database password here and the worker image has no Postgres client.

/** Runs `docker exec` and writes what the command prints to `file`. Rejects with the command's own error text (its stderr, short). */
export function execToFile(container, command, file, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file, { mode: 0o600 });
    const p = spawn("docker", ["exec", container, ...command], { stdio: ["ignore", "pipe", "pipe"], killSignal: "SIGINT", signal });
    let err = "";
    p.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
    p.stdout.pipe(out);
    p.on("error", reject);
    p.on("close", (code) => out.end(() => (code === 0 ? resolve() : reject(new Error(`${command[0]} failed: ${err.trim().slice(0, 300) || `exit ${code}`}`)))));
  });
}

/** Runs `docker exec -i` with `file` as its input and returns what it printed. */
export function execWithFile(container, command, file, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", ["exec", "-i", container, ...command], { stdio: ["pipe", "pipe", "pipe"], killSignal: "SIGINT", signal });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${command[0]} failed: ${err.trim().slice(0, 300) || `exit ${code}`}`))));
    createReadStream(file).on("error", reject).pipe(p.stdin).on("error", () => {}); // (the command may stop reading early)
  });
}

/** The name of the Postgres container Shipdok's own database runs in: the compose service `postgres` of the project this worker belongs to. */
export async function findPostgresContainer({ env = process.env, hostname = os.hostname() } = {}) {
  if (env.BACKUP_POSTGRES_CONTAINER) return env.BACKUP_POSTGRES_CONTAINER;
  let project = null;
  try { project = (await docker.getContainer(hostname).inspect()).Config.Labels?.["com.docker.compose.project"] ?? null; } catch { /* not in a container, or Docker cannot say */ }
  const labels = ["com.docker.compose.service=postgres", ...(project ? [`com.docker.compose.project=${project}`] : [])];
  const found = await docker.listContainers({ filters: { label: labels, status: ["running"] } });
  if (found.length !== 1) {
    throw new Error(found.length === 0
      ? "Could not find the Postgres container (Shipdok's own database). If it does not run in this Docker Compose project, set BACKUP_POSTGRES_CONTAINER to its name"
      : "More than one Postgres container matched; set BACKUP_POSTGRES_CONTAINER to the name of Shipdok's own");
  }
  return found[0].Names[0].replace(/^\//, "");
}

export async function findContainers({ appId, role }) {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL.managed}=true`, `${LABEL.app}=${appId}`, `${LABEL.role}=${role}`] },
  });
  return list.map((c) => docker.getContainer(c.Id));
}

// Every container Shipdok made for this app, whatever its role (live, or a candidate a dead worker left behind).
export async function findAppContainers(appId) {
  const list = await docker.listContainers({ all: true, filters: { label: [`${LABEL.managed}=true`, `${LABEL.app}=${appId}`] } });
  return list.map((c) => docker.getContainer(c.Id));
}

export function containerSpec({ image, name, labels, containerPort, hostPort, memoryMb, cpus, env, volumes = [] }) {
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
      // Docker keeps only a bounded copy of the output; the persistent copy is Shipdok's own (runtime.log).
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      // No privileged mode, no docker.sock, no host binds.
      // The container cannot start more than 512 processes, so a fork bomb in one app cannot take the whole machine down.
      // Deliberately NOT set (administrator's decision): `no-new-privileges` and a capability drop. A repository may legitimately need to
      // elevate (sudo or setuid programs, low ports, chown in an entrypoint), and Shipdok cannot know that in advance.
      PidsLimit: 512,
      // Persistent storage: Docker NAMED volumes, never host paths. A volume given with a name is the app's real data; without a name Docker
      // makes a throwaway (anonymous) one, which is what a candidate gets so that the old version's data is not touched while both run.
      ...(volumes.length ? { Mounts: volumes.map((v) => ({ Type: "volume", Target: v.path, ...(v.name ? { Source: v.name } : {}) })) } : {}),
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
  const started = Date.parse(info.State.StartedAt);
  return {
    status: info.State.Status,
    exitCode: info.State.ExitCode,
    oomKilled: info.State.OOMKilled === true,
    // Docker reports "0001-01-01..." for a container that has not ended; that is "no end time".
    finishedAt: Number.isFinite(ended) && ended > Date.parse("2000-01-01") ? ended : null,
    // When this RUN of the container began (a restart gives a new value), and which deployment's container it is.
    startedAt: Number.isFinite(started) && started > Date.parse("2000-01-01") ? started : null,
    deploymentId: info.Config?.Labels?.[LABEL.deployment] ?? null,
    restartPolicy: info.HostConfig?.RestartPolicy?.Name ?? "",
  };
}

// ---- Resource use ----
/**
 * Docker's stats answer -> { cpuPercent, memoryBytes, memoryLimitBytes }.
 * CPU is the share of ONE cpu (200 = two cpus fully busy), from the change since the sample Docker took before this one;
 * null when there is no earlier sample to compare with. Memory is what the app uses without the file cache the kernel can
 * take back (what `docker stats` shows too): cgroup v2 calls that inactive_file, v1 total_inactive_file.
 */
export function normalizeStats(raw) {
  const cpu = raw?.cpu_stats;
  const before = raw?.precpu_stats;
  let cpuPercent = null;
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (before?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (cpu?.system_cpu_usage ?? 0) - (before?.system_cpu_usage ?? 0);
  if (before?.cpu_usage?.total_usage > 0 && systemDelta > 0 && cpuDelta >= 0) {
    const cpus = cpu.online_cpus ?? cpu.cpu_usage?.percpu_usage?.length ?? 1;
    cpuPercent = Math.round((cpuDelta / systemDelta) * cpus * 100 * 10) / 10;
  }
  const mem = raw?.memory_stats ?? {};
  const cache = mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? 0;
  const memoryBytes = Math.max(0, (mem.usage ?? 0) - cache);
  // With no limit set Docker reports the host's memory (or a huge number); the caller only shows what the app was given.
  return { cpuPercent, memoryBytes, memoryLimitBytes: mem.limit > 0 ? mem.limit : null };
}

// One reading. With stream:false Docker waits about a second so that it can compare two samples.
export const containerStats = async (container) => normalizeStats(await container.stats({ stream: false }));

// ---- The app's own output ----
const seconds = (ms) => (ms / 1000).toFixed(3); // Docker takes "since"/"until" as seconds with decimals

// A stream of Docker's log frames that keeps going while the container runs. See dockerlogs.js to read it.
export const followLogs = (container, { since } = {}) =>
  container.logs({ follow: true, stdout: true, stderr: true, timestamps: true, ...(since != null && { since: seconds(since) }) });

// Everything between two moments, as one buffer of Docker's log frames.
export const fetchLogs = (container, { since, until } = {}) =>
  container.logs({
    follow: false, stdout: true, stderr: true, timestamps: true,
    ...(since != null && { since: seconds(since) }), ...(until != null && { until: seconds(until) }),
  });

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

// ---- Images: what retention needs. Everything here is scoped by the ownership labels written at build time. ----

// null when the image does not exist.
export async function imageInfo(image) {
  try {
    const i = await docker.getImage(image).inspect();
    return { architecture: i.Architecture, size: Number(i.Size), labels: i.Config?.Labels ?? {} };
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

export async function imageSize(image) {
  return (await docker.getImage(image).inspect()).Size;
}

// Every tag of every image built for this app by Shipdok: [{ tag, deploymentId, size }]. Images with no tag are not listed.
export async function listAppImages(appId) {
  const images = await docker.listImages({
    filters: { label: [`${LABEL.managed}=true`, `${LABEL.app}=${appId}`] },
  });
  const out = [];
  for (const img of images) {
    for (const tag of img.RepoTags ?? []) {
      if (tag.startsWith('shipdok/')) out.push({ tag, deploymentId: img.Labels?.[LABEL.deployment] ?? null, size: Number(img.Size) });
    }
  }
  return out;
}

// Total size of all image layers on the host, each layer counted once. The difference before and after a removal is the
// space really freed (image sizes alone are misleading: versions of one app share their base layers).
export async function imageLayersSize() {
  return Number((await docker.df()).LayersSize);
}

// The image a container was created from, as the tag it was created with (null if Docker cannot tell).
export async function containerImage(container) {
  return (await container.inspect()).Config?.Image ?? null;
}

// Removes one image tag, without force. 'removed' | 'gone' (it was not there) | 'in-use' (a container still uses it).
export async function removeImageStrict(image) {
  try {
    await docker.getImage(image).remove({ force: false });
    return 'removed';
  } catch (err) {
    if (err.statusCode === 404) return 'gone';
    if (err.statusCode === 409) return 'in-use';
    throw err;
  }
}

export async function imageArch(image) {
  return (await docker.getImage(image).inspect()).Architecture;
}

export async function hostArchitecture() {
  return (await docker.info()).Architecture;
}

// Removes a container for good, stopping it first if it runs. 'gone' when it was not there; any other failure is thrown (unlike removeQuietly).
export async function removeContainerStrict(c) {
  try {
    await c.remove({ force: true });
    return 'removed';
  } catch (err) {
    if (err.statusCode === 404) return 'gone';
    throw err;
  }
}

export async function removeQuietly(c) {
  try {
    // `v` removes the container's ANONYMOUS volumes (the throwaway ones of a candidate). Named volumes are never removed by it.
    await c.remove({ force: true, v: true });
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

// ---- Volumes (persistent storage). Only ever ones Shipdok made: named shipdok-vol-<id> AND carrying the ownership label. ----
const VOLUME_NAME_RE = /^shipdok-vol-[A-Za-z0-9-]{1,64}$/;

/** Creates the volume if it does not exist (Docker answers with the existing one otherwise), with the ownership labels. */
export const ensureVolume = ({ name, labels }, { docker: d = docker } = {}) => d.createVolume({ Name: name, Labels: labels });

/** Removes one volume and its data. 'removed', 'gone' (it was not there) or 'in-use' (a container still uses it); a volume that is not Shipdok's is refused. */
export async function removeVolumeStrict(name, { docker: d = docker } = {}) {
  if (!VOLUME_NAME_RE.test(name)) throw new Error('That volume does not belong to Shipdok');
  const volume = d.getVolume(name);
  let info;
  try {
    info = await volume.inspect();
  } catch (err) {
    if (err.statusCode === 404) return 'gone';
    throw err;
  }
  if (info?.Labels?.[LABEL.managed] !== 'true') throw new Error('That volume does not belong to Shipdok');
  try {
    await volume.remove();
    return 'removed';
  } catch (err) {
    if (err.statusCode === 404) return 'gone';
    if (err.statusCode === 409) return 'in-use';
    throw err;
  }
}

// ---- Build cache ----
// BuildKit's cache is shared by every build on the host (no per-app owner), so it is looked at and cleaned as a whole.

/** { totalBytes, reclaimableBytes } of the build cache, or null if this Docker does not report it. "Reclaimable" = not used by a build right now. */
export async function buildCacheUsage({ docker: d = docker } = {}) {
  const records = (await d.df()).BuildCache;
  if (!Array.isArray(records)) return null;
  let totalBytes = 0;
  let reclaimableBytes = 0;
  for (const r of records) {
    const size = Number(r.Size) || 0;
    totalBytes += size;
    if (!r.InUse) reclaimableBytes += size;
  }
  return { totalBytes, reclaimableBytes };
}

/**
 * Removes build cache that no build is using. `olderThanHours` keeps what was used more recently than that (null = everything unused).
 * Docker never removes cache a running build holds. Returns the bytes Docker says it freed.
 */
export async function pruneBuildCache({ olderThanHours = null } = {}, { docker: d = docker } = {}) {
  if (olderThanHours !== null && !(Number.isInteger(olderThanHours) && olderThanHours > 0)) throw new Error('olderThanHours must be a whole number of hours');
  const query = { all: 1 }; // all: also the intermediate steps, not only the dangling records
  if (olderThanHours !== null) query.filters = JSON.stringify({ until: [`${olderThanHours}h`] });
  const result = await new Promise((resolve, reject) => {
    d.modem.dial({ path: '/build/prune?', method: 'POST', options: query, statusCodes: { 200: true, 500: 'server error' } }, (err, data) => (err ? reject(err) : resolve(data)));
  });
  return { freedBytes: Number(result?.SpaceReclaimed) || 0 };
}

/**
 * The size in bytes of every Docker volume, by name (a Map; only those Docker reports a size for). Docker has to walk every file of every volume to add
 * them up, so this takes several seconds, longer on a big volume or a slow disk: it is only called when the administrator asks.
 * `?type=volume` asks Docker to add up volumes only (an older Docker ignores it and answers with everything, which is slower but the same figures).
 */
export async function volumeSizes({ docker: d = docker } = {}) {
  const result = await new Promise((resolve, reject) => {
    d.modem.dial({ path: '/system/df?', method: 'GET', options: { type: 'volume' }, statusCodes: { 200: true, 500: 'server error' } }, (err, data) => (err ? reject(err) : resolve(data)));
  });
  const sizes = new Map();
  for (const v of result?.Volumes ?? []) {
    const size = Number(v.UsageData?.Size);
    if (typeof v.Name === 'string' && Number.isFinite(size) && size >= 0) sizes.set(v.Name, size); // -1: Docker could not say
  }
  return sizes;
}
