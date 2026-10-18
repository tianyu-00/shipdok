// A stand-in for Docker and child processes, so deploy()'s orchestration (order of steps, cleanup, swap,
// rollback, cancellation) can be tested without Docker. Every action is appended to `events`.
import { abortError, isAbort } from "../src/docker.js";

export { abortError };

/**
 * cfg.previous        names of containers already live for the app
 * cfg.head            the commit `git rev-parse HEAD` reports (default 'abc123def')
 * cfg.onRun(cmd, args, opts)   called for git/docker commands; may throw (e.g. a failed build or an abort)
 * cfg.health.candidate / cfg.health.live   async (opts) => void; may throw to simulate an unhealthy container
 */
export function fakeEngine(cfg = {}) {
  const events = [];
  const ev = (e) => events.push(e);

  // Containers created for the NEW image. Real Docker refuses to delete an image while any container uses it.
  const usingNewImage = new Set();

  const container = (name) => ({
    name,
    async start() {
      ev(`start ${name}`);
    },
    async stop() {
      ev(`stop ${name}`);
    },
    async remove() {
      usingNewImage.delete(name);
      ev(`remove ${name}`);
    },
  });
  const previous = (cfg.previous ?? []).map(container);

  // `git -C dir fetch ...` -> "fetch"; `git clone ...` -> "clone"
  const gitSub = (args) => {
    let i = 0;
    while (args[i] === "-C" || args[i] === "-c") i += 2;
    return args[i];
  };

  const engine = {
    events,
    runs: [], // every command with its arguments, for assertions
    abortError,
    isAbort,
    workDir: null,
    labelsFor: () => ({}),
    async run(cmd, args, opts = {}) {
      engine.runs.push({ cmd, args });
      ev(`run ${cmd} ${cmd === "git" ? gitSub(args) : args[0]}`);
      if (cmd === "git") engine.workDir = args[0] === "-C" ? args[1] : args.at(-1);
      await cfg.onRun?.(cmd, args, opts);
    },
    async capture() {
      return cfg.head ?? "abc123def";
    },
    async findContainers() {
      return previous;
    },
    async createContainer({ name, hostPort }) {
      ev(`create ${name} port=${hostPort || "temp"}`);
      usingNewImage.add(name);
      return container(name);
    },
    async waitHealthy(c, opts) {
      ev(`health ${c.name}`);
      const role = c.name.endsWith("-candidate") ? "candidate" : "live";
      await cfg.health?.[role]?.(opts);
    },
    async tailLogs() {
      return "";
    },
    async removeQuietly(c) {
      await c.remove();
    },
    async removeImage(image) {
      // The real helper swallows this failure, which is exactly why the order of cleanup matters.
      ev(usingNewImage.size ? `rmi-BLOCKED ${image}` : `rmi ${image}`);
    },
    async imageArch() {
      return "amd64";
    },
    async hostArchitecture() {
      return "x86_64";
    },
  };
  return engine;
}
