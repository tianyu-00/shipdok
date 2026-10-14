// Docker helpers. No arg parsing, no process.exit, no knowledge of Express or BullMQ.
import Docker from "dockerode";
import { spawn } from "node:child_process";

export const docker = new Docker(); // /var/run/docker.sock: treat as highly privileged

// Ownership labels. Every lookup and cleanup filters on these.
export const LABEL = {
  managed: "shipdok.managed",
  app: "shipdok.app-id",
  deployment: "shipdok.deployment-id",
  role: "shipdok.role", // candidate | live
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

export async function findContainers({ appId, role }) {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL.managed}=true`, `${LABEL.app}=${appId}`, `${LABEL.role}=${role}`] },
  });
  return list.map((c) => docker.getContainer(c.Id));
}

export async function createContainer({ image, name, labels, containerPort, hostPort, memoryMb, cpus, env }) {
  const cport = `${containerPort}/tcp`;
  return docker.createContainer({
    Image: image,
    name,
    Labels: labels,
    Env: env,
    ExposedPorts: { [cport]: {} },
    HostConfig: {
      PortBindings: { [cport]: [{ HostPort: String(hostPort) }] }, // '' = Docker picks a free port
      Memory: memoryMb * 1024 * 1024,
      NanoCpus: cpus * 1e9,
      RestartPolicy: { Name: "on-failure", MaximumRetryCount: 5 },
      // No privileged mode, no docker.sock, no host binds.
    },
  });
}

export async function hostPortOf(container, containerPort) {
  const info = await container.inspect();
  return info.NetworkSettings.Ports[`${containerPort}/tcp`]?.[0]?.HostPort;
}

// Fail fast if the container exits; otherwise poll HTTP until 200 or timeout.
export async function waitHealthy(container, { containerPort, health, timeoutMs = 30_000 }) {
  const deadline = Date.now() + timeoutMs;
  const port = await hostPortOf(container, containerPort);
  while (Date.now() < deadline) {
    const { State } = await container.inspect();
    if (!State.Running) {
      throw new Error(`Container exited early (code ${State.ExitCode}, OOMKilled=${State.OOMKilled})`);
    }
    if (health) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${health}`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
    } else {
      // Weak fallback: still running after 3s does not prove readiness.
      await sleep(3000);
      if ((await container.inspect()).State.Running) return;
    }
    await sleep(1000);
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
