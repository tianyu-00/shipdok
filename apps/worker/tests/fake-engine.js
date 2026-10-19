// A stand-in for Docker and child processes, so deploy()'s orchestration (order of steps, cleanup, swap,
// rollback, cancellation) can be tested without Docker. Every action is appended to `events`.
import { Readable } from 'node:stream';
import { abortError, isAbort } from '../src/docker.js';

export { abortError };

// One line the way Docker's log API frames it: [type, 0, 0, 0, length] + "<RFC3339Nano> <text>\n"
const logFrame = ({ at, stream, text }) => {
  const payload = Buffer.from(`${new Date(at).toISOString().replace('Z', '000000Z')} ${text}\n`);
  const header = Buffer.alloc(8);
  header[0] = stream === 'stderr' ? 2 : 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

/**
 * cfg.previous        names of containers already live for the app
 * cfg.stopped         names (from cfg.previous) that are NOT running, like the containers of a stopped app
 * cfg.failOn          { 'start old': Error, 'create live': Error, ... } an action that should throw (matched on "<verb> <name suffix>")
 * cfg.head            the commit `git rev-parse HEAD` reports (default 'abc123def')
 * cfg.onRun(cmd, args, opts)   called for git/docker commands; may throw (e.g. a failed build or an abort)
 * cfg.health.candidate / cfg.health.live   async (opts) => void; may throw to simulate an unhealthy container
 */
export function fakeEngine(cfg = {}) {
  const events = [];
  const ev = (e) => events.push(e);

  // Containers created for the NEW image. Real Docker refuses to delete an image while any container uses it.
  const usingNewImage = new Set();

  const failure = (verb, name) => {
    for (const [key, err] of Object.entries(cfg.failOn ?? {})) {
      const [v, suffix] = key.split(' ');
      if (v === verb && name.endsWith(suffix)) throw err;
    }
  };

  const container = (name) => ({
    name,
    async start() { failure('start', name); ev(`start ${name}`); },
    async stop() { ev(`stop ${name}`); },
    async remove() { usingNewImage.delete(name); ev(`remove ${name}`); },
  });
  const previous = (cfg.previous ?? []).map(container);

  // `git -C dir fetch ...` -> "fetch"; `git clone ...` -> "clone"
  const gitSub = (args) => { let i = 0; while (args[i] === '-C' || args[i] === '-c') i += 2; return args[i]; };

  const engine = {
    events,
    runs: [], // every command with its arguments, for assertions
    abortError,
    isAbort,
    workDir: null,
    labelsFor: () => ({}),
    async run(cmd, args, opts = {}) {
      engine.runs.push({ cmd, args, opts });
      ev(`run ${cmd} ${cmd === 'git' ? gitSub(args) : args[0]}`);
      if (cmd === 'git') engine.workDir = args[0] === '-C' ? args[1] : args.at(-1);
      await cfg.onRun?.(cmd, args, opts);
    },
    async capture() { return cfg.head ?? 'abc123def'; },
    async findContainers(filter) { (engine.lookups ??= []).push(filter); return previous; },
    async createContainer({ name, hostPort }) { failure('create', name); ev(`create ${name} port=${hostPort || 'temp'}`); usingNewImage.add(name); return container(name); },
    async isRunning(c) { return !(cfg.stopped ?? []).includes(c.name); },
    // The real helpers also accept "already stopped/started" (Docker's 304); the fake containers never raise it.
    async stopContainer(c) { await c.stop(); },
    async startContainer(c) { await c.start(); },
    async restartContainer(c) { failure('restart', c.name); ev(`restart ${c.name}`); },
    async waitHealthy(c, opts) {
      ev(`health ${c.name}`);
      const role = c.name.endsWith('-candidate') ? 'candidate' : 'live';
      await cfg.health?.[role]?.(opts);
    },
    async tailLogs() { return ''; },
    async removeQuietly(c) { await c.remove(); },
    async removeImage(image) {
      // The real helper swallows this failure, which is exactly why the order of cleanup matters.
      ev(usingNewImage.size ? `rmi-BLOCKED ${image}` : `rmi ${image}`);
    },
    // ---- for the monitor: tests change these between ticks to play out a crash, a reboot, an outside stop... ----
    facts: { status: 'running', exitCode: 0, oomKilled: false, finishedAt: null, restartPolicy: 'no', ...(cfg.facts ?? {}) },
    probe: cfg.probe ?? true,
    cause: cfg.cause ?? 'crash',
    async containerFacts() { return { ...engine.facts }; },
    async probeHealth(c, opts) { ev(`probe ${c.name}`); engine.lastProbe = opts; return typeof engine.probe === 'function' ? engine.probe() : engine.probe; },
    async deathCause(c) { ev(`cause ${c.name}`); return engine.cause; },
    async setRestartPolicyNone(c) { ev(`policy ${c.name}`); engine.facts.restartPolicy = 'no'; },
    // ---- the app's own output, as Docker holds it: say() adds a line, followers see it live, fetchLogs reads a window ----
    logLines: [],
    followers: [],
    failFetch: cfg.failFetch ?? false,
    ignoreSince: cfg.ignoreSince ?? false, // behave like a Docker that returns older lines than asked for
    followSince: [], // the "since" of every follow request
    say(stream, text, at) {
      const line = { at, stream, text };
      engine.logLines.push(line);
      for (const f of engine.followers) if (!f.destroyed && at >= f.since) f.push(logFrame(line));
    },
    async followLogs(c, { since } = {}) {
      ev(`follow ${c.name}`);
      engine.followSince.push(since);
      const s = new Readable({ read() {} });
      s.since = engine.ignoreSince ? 0 : (since ?? 0);
      for (const line of engine.logLines) if (line.at >= s.since) s.push(logFrame(line));
      engine.followers.push(s);
      return s;
    },
    async fetchLogs(c, { since, until } = {}) {
      ev(`fetch ${c.name}`);
      if (engine.failFetch) throw Object.assign(new Error('no such container'), { statusCode: 404 });
      return Buffer.concat(engine.logLines
        .filter((l) => (engine.ignoreSince || since == null || l.at >= since) && (until == null || l.at < until))
        .map(logFrame));
    },
    dropFollowers() { for (const f of engine.followers) f.push(null); engine.followers = []; }, // a connection that ends
    async imageArch() { return 'amd64'; },
    async hostArchitecture() { return 'x86_64'; },
  };
  return engine;
}
