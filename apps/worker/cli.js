#!/usr/bin/env node
// Thin command-line wrapper around deploy(). Handy for manual testing.
//
// Usage: node cli.js --repo <url> --ref main --app my-app \
//          --container-port 3000 --host-port 8080 --health /health \
//          [--dir backend] [--env-file /path/outside/repo/.env]
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { deploy } from "./src/deploy.js";
import { parseEnvFile } from "./src/docker.js";

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
    "env-file": { type: "string" },
  },
});

for (const k of ["repo", "app", "container-port", "host-port"]) {
  if (!a[k]) {
    console.error(`Missing --${k}`);
    process.exit(2);
  }
}

const env = a["env-file"] ? parseEnvFile(await readFile(a["env-file"], "utf8")) : [];

const result = await deploy({
  repo: a.repo,
  ref: a.ref,
  appId: a.app,
  containerPort: a["container-port"],
  hostPort: a["host-port"],
  health: a.health,
  dir: a.dir,
  memoryMb: Number(a.memory),
  cpus: Number(a.cpus),
  env,
});

process.exitCode = result.ok ? 0 : 1;
