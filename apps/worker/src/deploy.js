// The deployment itself: clone -> build -> candidate -> health check -> swap.
// Importable by the BullMQ worker. Returns a result object; never calls process.exit.
//
// Cancellation: until the SWAP begins, everything honours opts.signal (clone, build, candidate start,
// health wait). The swap is the point of no return: once the old container has been stopped, aborting could
// leave the app down, so a cancel that arrives then is ignored and the deployment completes.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertRelativeDir, resolveBuildDir } from './paths.js';
import * as realEngine from './docker.js';
import { checkoutSource, gitEnvironment } from './git.js';

/**
 * @param {object} opts
 * @param {string} opts.repo            git clone URL
 * @param {string} opts.appId           stable app ID (used in Docker labels)
 * @param {number|string} opts.containerPort
 * @param {number|string} opts.hostPort
 * @param {string} [opts.deploymentId]  database deployment ID; generated if absent (CLI use)
 * @param {string} [opts.slug]          readable name for image tags and container names
 * @param {string} [opts.ref='main']
 * @param {string} [opts.commit]       exact commit to build (a webhook push). Without it, the branch head at clone time.
 * @param {string} [opts.dir='.']       app root inside the repo
 * @param {string} [opts.health]        HTTP health path, e.g. /health
 * @param {number} [opts.memoryMb=512]
 * @param {number} [opts.cpus=1]
 * @param {string[]} [opts.env=[]]      ['KEY=VALUE', ...] for the container
 * @param {Record<string,string>} [opts.gitEnv]  extra environment for GIT ONLY (a GitHub token). Never given to docker or the container.
 * @param {AbortSignal} [opts.signal]   aborts work in progress, up to the point of no return
 * @param {() => Promise<{proceed: boolean, outcome?: string, by?: string, start?: boolean}>} [opts.beforeSwap]
 *        asked right before the swap; proceed:false stops the deployment instead (e.g. cancelled, or a newer one already succeeded).
 *        start:false means the app is stopped: the new container is created but not started (default: start it)
 * @param {(msg: string) => void} [opts.log]
 * @param {(status: 'starting'|'validating') => void} [opts.onStatus]  progress hook
 * @param {(sha: string) => void} [opts.onCommit]                      resolved commit hook
 * @param {object} [eng]                the Docker/process engine; tests pass a fake
 * @returns {Promise<{ok: true, deploymentId: string, image: string, started: boolean}
 *   | {ok: false, stopped: true, outcome?: string, by?: string, deploymentId: string, image: string}
 *   | {ok: false, error: string, deploymentId: string, image: string}>}
 */
// SHA-1, or SHA-256 for repositories that use it. Strict: this value ends up in a git command.
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export async function deploy(opts, eng = realEngine) {
  const o = { ref: 'main', dir: '.', memoryMb: 512, cpus: 1, env: [], ...opts };
  const log = o.log ?? ((m) => console.log(`[${new Date().toISOString()}] ${m}`));
  const notify = (fn, ...args) => { try { fn?.(...args); } catch { /* hooks must never break a deploy */ } };
  const deploymentId = o.deploymentId ?? randomBytes(4).toString('hex');
  const name = o.slug ?? o.appId;
  const image = `shipdok/${name}:${deploymentId}`;
  const healthOpts = { containerPort: o.containerPort, health: o.health };
  const { signal } = o;
  const stopIfAborted = () => { if (signal?.aborted) throw eng.abortError(); };

  const make = (role, hostPort) => eng.createContainer({
    image,
    name: `shipdok-${name}-${deploymentId}-${role}`,
    labels: eng.labelsFor({ appId: o.appId, deploymentId, role }),
    containerPort: o.containerPort,
    hostPort,
    memoryMb: o.memoryMb,
    cpus: o.cpus,
    env: o.env,
  });

  // Health check that prints container output on failure, before the container is removed.
  // `sig` is only passed before the point of no return.
  const checked = async (container, label, sig) => {
    try {
      await eng.waitHealthy(container, { ...healthOpts, signal: sig });
    } catch (err) {
      if (!eng.isAbort(err)) {
        const logs = await eng.tailLogs(container, o.env);
        if (logs) log(`--- last container output (${label}) ---\n${logs}\n--- end ---`);
      }
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

  // Same for the commit: refuse anything that is not a plain hex object id before any side effects.
  if (o.commit != null && !COMMIT_RE.test(o.commit)) {
    log('Deployment FAILED: Invalid commit id');
    return { ok: false, deploymentId, image, error: 'Invalid commit id' };
  }

  const workDir = await mkdtemp(join(tmpdir(), 'shipdok-'));
  const previous = await eng.findContainers({ appId: o.appId, role: 'live' });
  let candidate;
  let finalC;
  let committed = false; // true once the swap has begun: from then on, no cancellation
  let startAfterSwap = true; // false for an app the administrator has stopped

  try {
    const head = await checkoutSource(eng, {
      workDir, repo: o.repo, ref: o.ref, commit: o.commit, env: gitEnvironment(o.gitEnv), signal, log,
    });
    notify(o.onCommit, head);
    // Resolve symlinks AFTER cloning: the API validates the string, but only the real path is trustworthy.
    const buildDir = await resolveBuildDir(workDir, o.dir);

    log(`Building ${image}`);
    await eng.run('docker', [
      'build', '-t', image,
      '--label', 'shipdok.managed=true',
      '--label', `shipdok.app-id=${o.appId}`,
      '--label', `shipdok.deployment-id=${deploymentId}`,
      buildDir,
    ], { env: { ...process.env, DOCKER_BUILDKIT: '1' }, signal });

    log(`Image arch: ${await eng.imageArch(image)}, host: ${await eng.hostArchitecture()}`);
    stopIfAborted();

    log('Starting candidate on a temporary port');
    notify(o.onStatus, 'starting');
    candidate = await make('candidate', '');
    await candidate.start();
    notify(o.onStatus, 'validating');
    await checked(candidate, 'candidate', signal);
    log('Candidate healthy');
    await eng.removeQuietly(candidate);
    candidate = null;

    // ---- Last chance to stop. Ask whether to go ahead (cancelled? a newer deployment already live?). ----
    if (o.beforeSwap) {
      const gate = await o.beforeSwap();
      startAfterSwap = gate?.start !== false;
      if (gate && gate.proceed === false) {
        log(`Stopping before the swap (${gate.outcome ?? 'stopped'}); the running version is untouched`);
        await eng.removeImage(image); // built for nothing: nothing will ever run it
        return { ok: false, stopped: true, outcome: gate.outcome, by: gate.by, deploymentId, image };
      }
    } else {
      stopIfAborted();
    }
    committed = true; // ---- point of no return ----

    // Remember which containers were serving before we stop them: a failed swap may only bring THOSE back.
    // (A stopped app's container must stay stopped.) If Docker cannot tell, assume it was running.
    const wasRunning = await Promise.all(previous.map((old) => eng.isRunning(old).catch(() => true)));
    for (const old of previous) await old.stop().catch(() => {});
    try {
      finalC = await make('live', o.hostPort);
      if (startAfterSwap) {
        await finalC.start();
        await checked(finalC, 'live'); // deliberately no signal
      } else {
        log('This app is stopped: the new version is created but not started. Start it when you want it running');
      }
    } catch (err) {
      log(`Swap failed: ${err.message}. Restoring previous version`);
      if (finalC) await eng.removeQuietly(finalC);
      for (const [i, old] of previous.entries()) {
        if (wasRunning[i]) await old.start().catch((e) => log(`RESTORE FAILED: ${e.message}`));
      }
      throw err;
    }

    for (const old of previous) await eng.removeQuietly(old);
    log(`Deployed ${name} (${deploymentId}) on :${o.hostPort}${startAfterSwap ? '' : ' (not started: the app is stopped)'}`);
    return { ok: true, deploymentId, image, started: startAfterSwap };
  } catch (err) {
    if (!committed && signal?.aborted) {
      log('Deployment stopped on request; the running version is untouched');
      // The candidate must go FIRST: Docker will not delete an image while any container still uses it,
      // and removeImage deliberately ignores that failure. (The finally block would be too late.)
      if (candidate) { await eng.removeQuietly(candidate); candidate = null; }
      await eng.removeImage(image);
      return { ok: false, stopped: true, deploymentId, image };
    }
    log(`Deployment FAILED: ${err.message}`);
    return { ok: false, deploymentId, image, error: err.message };
  } finally {
    if (candidate) await eng.removeQuietly(candidate);
    await rm(workDir, { recursive: true, force: true });
  }
}
