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
import { LABEL } from '@shipdok/shared';
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
 * @param {string} [opts.reuseImage]   a rollback: an existing image of this app to run instead of cloning and building. It is never deleted by this function.
 * @param {string} [opts.dir='.']       app root inside the repo
 * @param {string} [opts.health]        HTTP health path, e.g. /health
 * @param {number} [opts.memoryMb=512]
 * @param {number} [opts.cpus=1]
 * @param {string[]} [opts.env=[]]      ['KEY=VALUE', ...] for the container
 * @param {Record<string,string>} [opts.gitEnv]  extra environment for GIT ONLY (a GitHub token). Never given to docker or the container.
 * @param {(container: object) => Promise<void>} [opts.onRetire]  called with each old container after the new one is live, before it is removed (save its output)
 * @param {number|null} [opts.buildTimeoutMinutes]  stop the clone and the build if they take longer than this; none/null = no limit
 * @param {number} [opts.retireTimeoutMs=10000]  how long to wait for onRetire
 * @param {{write: Function, line: Function}} [opts.logSink]  also receives the output of git and docker build (the deployment's log file)
 * @param {AbortSignal} [opts.signal]   aborts work in progress, up to the point of no return
 * @param {() => Promise<{proceed: boolean, outcome?: string, by?: string, start?: boolean}>} [opts.beforeSwap]
 *        asked right before the swap; proceed:false stops the deployment instead (e.g. cancelled, or a newer one already succeeded).
 *        start:false means the app is stopped: the new container is created but not started (default: start it)
 * @param {(msg: string) => void} [opts.log]
 * @param {(status: 'starting'|'validating') => void} [opts.onStatus]  progress hook
 * @param {(sha: string) => void} [opts.onCommit]                      resolved commit hook
 * @param {object} [eng]                the Docker/process engine; tests pass a fake
 * @returns {Promise<{ok: true, deploymentId: string, image: string, imageBytes: number|null, started: boolean}
 *   | {ok: false, stopped: true, outcome?: string, by?: string, deploymentId: string, image: string}
 *   | {ok: false, error: string, deploymentId: string, image: string}>}
 */
// SHA-1, or SHA-256 for repositories that use it. Strict: this value ends up in a git command.
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REUSE_TAG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function deploy(opts, eng = realEngine) {
  const o = { ref: 'main', dir: '.', memoryMb: 512, cpus: 1, env: [], ...opts };
  const log = o.log ?? ((m) => console.log(`[${new Date().toISOString()}] ${m}`));
  const notify = (fn, ...args) => { try { fn?.(...args); } catch { /* hooks must never break a deploy */ } };
  const deploymentId = o.deploymentId ?? randomBytes(4).toString('hex');
  const name = o.slug ?? o.appId;
  const reused = o.reuseImage != null; // a rollback: the image already exists and belongs to an earlier deployment
  const image = reused ? o.reuseImage : `shipdok/${name}:${deploymentId}`;
  const healthOpts = { containerPort: o.containerPort, health: o.health };
  const { signal } = o;
  // The build time limit covers the clone and the build together (not the health check, which has its own). It aborts them the same way a
  // cancel does, but it is remembered, so that it is reported as a FAILURE with its own message and not as "stopped on request".
  const limitMs = o.buildTimeoutMinutes ? o.buildTimeoutMinutes * 60_000 : null;
  const limit = limitMs ? new AbortController() : null;
  let timedOut = false;
  let limitTimer = null;
  const buildSignal = limit ? AbortSignal.any([signal, limit.signal].filter(Boolean)) : signal;
  const startLimit = () => { if (limit) limitTimer = setTimeout(() => { timedOut = true; limit.abort(); }, limitMs); };
  const stopLimit = () => { clearTimeout(limitTimer); limitTimer = null; };
  const timeoutMessage = () => `The build took longer than ${o.buildTimeoutMinutes} minute${o.buildTimeoutMinutes === 1 ? '' : 's'} and was stopped (the limit is a setting of the app)`;
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

  // The old container's output must be saved before the container is removed. Best effort, and never allowed to hold
  // a deployment up for long: a hook that fails or hangs is given up on.
  const retire = async (container) => {
    if (!o.onRetire) return;
    let timer;
    try {
      await Promise.race([
        Promise.resolve(o.onRetire(container)),
        new Promise((resolve) => { timer = setTimeout(resolve, o.retireTimeoutMs ?? 10_000); }),
      ]);
    } catch (err) {
      log(`Could not save the old version's output: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  };

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

  // A reused image must be one of THIS app's own (shipdok/<slug>:<deployment id>): refuse anything else before side effects.
  if (reused && !(typeof image === 'string' && image.startsWith(`shipdok/${name}:`) && REUSE_TAG_RE.test(image.slice(`shipdok/${name}:`.length)))) {
    log('Deployment FAILED: Invalid image reference');
    return { ok: false, deploymentId, image, error: 'Invalid image reference' };
  }

  const workDir = await mkdtemp(join(tmpdir(), 'shipdok-'));
  const previous = await eng.findContainers({ appId: o.appId, role: 'live' });
  let candidate;
  let finalC;
  let committed = false; // true once the swap has begun: from then on, no cancellation
  let startAfterSwap = true; // false for an app the administrator has stopped

  try {
    if (reused) {
      // A rollback: no clone, no build. The image must still exist and must be this app's own.
      log(`Reusing image ${image} (no rebuild)`);
      const info = await eng.imageInfo(image);
      if (!info) throw new Error('The image of that version no longer exists (it was removed to free space), so it cannot be rolled back to');
      if (info.labels?.[LABEL.managed] !== 'true' || info.labels?.[LABEL.app] !== o.appId) throw new Error('That image does not belong to this app');
    } else {
      startLimit();
      try {
        const head = await checkoutSource(eng, {
          workDir, repo: o.repo, ref: o.ref, commit: o.commit, env: gitEnvironment(o.gitEnv), signal: buildSignal, sink: o.logSink, log,
        });
        notify(o.onCommit, head);
        // Resolve symlinks AFTER cloning: the API validates the string, but only the real path is trustworthy.
        const buildDir = await resolveBuildDir(workDir, o.dir);

        log(`Building ${image}`);
        await eng.run('docker', [
          'build', '--progress=plain', '-t', image, // plain: readable in a file, no terminal redrawing
          '--label', 'shipdok.managed=true',
          '--label', `shipdok.app-id=${o.appId}`,
          '--label', `shipdok.deployment-id=${deploymentId}`,
          buildDir,
        ], { env: { ...process.env, DOCKER_BUILDKIT: '1' }, signal: buildSignal, sink: o.logSink });
      } finally {
        stopLimit();
      }
    }
    log(`Image arch: ${await eng.imageArch(image)}, host: ${await eng.hostArchitecture()}`);
    const imageBytes = await eng.imageSize(image).then(Number, () => null); // for the clean-up summary; never worth failing a deployment
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
        if (!reused) await eng.removeImage(image); // built for nothing: nothing will ever run it (a reused image belongs to an earlier version)
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

    for (const old of previous) {
      await retire(old); // hand over its last output before it disappears
      await eng.removeQuietly(old);
    }
    log(`Deployed ${name} (${deploymentId}) on :${o.hostPort}${startAfterSwap ? '' : ' (not started: the app is stopped)'}`);
    return { ok: true, deploymentId, image, imageBytes, started: startAfterSwap };
  } catch (err) {
    if (!committed && signal?.aborted) {
      log('Deployment stopped on request; the running version is untouched');
      // The candidate must go FIRST: Docker will not delete an image while any container still uses it,
      // and removeImage deliberately ignores that failure. (The finally block would be too late.)
      if (candidate) { await eng.removeQuietly(candidate); candidate = null; }
      if (!reused) await eng.removeImage(image);
      return { ok: false, stopped: true, deploymentId, image };
    }
    // A limit that fired is a failure with its own message, whatever error the aborted command raised. (A cancel was handled above.)
    const message = timedOut ? timeoutMessage() : err.message;
    log(`Deployment FAILED: ${message}`);
    return { ok: false, deploymentId, image, error: message };
  } finally {
    stopLimit();
    if (candidate) await eng.removeQuietly(candidate);
    await rm(workDir, { recursive: true, force: true });
  }
}
