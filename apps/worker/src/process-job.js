// The body of a deploy job, separated from worker.js so it can be tested without Redis or Docker.
import { createRedactor, secretsFromGitEnv, logFilePath, logRoot as defaultLogRoot } from '@shipdok/shared';
import { deploy } from './deploy.js';
import * as store from './db.js';
import { loadAppEnv, EnvDecryptError } from './envvars.js';
import { resolveGitAuth, GitAuthError } from './gitauth.js';
import { createLogSink, DEFAULT_MAX_BYTES } from './buildlog.js';
import { pruneApp } from './prune.js';

// Status updates are best-effort: a database hiccup must not abort a deployment mid-swap.
const tolerate = (label) => (err) => console.error(`Could not record ${label}: ${err.message}`);

// The values of "KEY=VALUE" strings: what must never appear in a log.
const valuesOf = (env) => (env ?? []).map((kv) => kv.slice(kv.indexOf('=') + 1));

export async function processDeployJob(
  job,
  {
    secretsKey, deployFn = deploy, db = store, loadEnv = loadAppEnv, pollMs = 1000, github = null,
    logRoot = defaultLogRoot(), logMaxBytes = DEFAULT_MAX_BYTES, collector = null, pruneFn = pruneApp,
  },
) {
  const d = job.data;
  const id = d.deploymentId;
  if (!id || !d.appId) throw new Error('Deploy job is missing deploymentId or appId');

  // The deployment's own log file (build output and progress), kept until the deployment is deleted. Everything
  // about it is best effort: a log that cannot be written must never fail or slow down a deployment.
  let sink = null;
  let redact = createRedactor([]); // grows as secrets become known (the app's variables, the GitHub token)

  const log = (msg) => {
    console.log(`[job ${job.id}] ${msg}`);
    Promise.resolve(job.log(msg)).catch(() => {}); // kept in Redis for now; real log storage comes later
    for (const piece of String(msg).split('\n')) sink?.line('shipdok', piece); // one log line per line of text
  };

  // Claim the deployment. If it was cancelled or superseded while it waited in the queue, it is no longer
  // 'queued' and we must not build anything. Errors here propagate: we cannot proceed without a claim.
  if (!(await db.claim(id))) {
    log('Skipped: this deployment is no longer queued (cancelled or superseded)');
    return { deploymentId: id, skipped: true };
  }

  try {
    sink = createLogSink({ file: logFilePath(logRoot, d.appId, id, 'build'), redact: (t) => redact(t), maxBytes: logMaxBytes });
    await db.openLogFile(d.appId, id, 'build');
  } catch (err) {
    tolerate('log')(err); // the sink (if it exists) still writes the file; only the record of it is missing
  }

  try {
    return await execute();
  } finally {
    if (sink) {
      const finished = await sink.close();
      await Promise.resolve(db.closeLogFile(id, 'build', finished)).catch(tolerate('log record'));
    }
  }

  async function execute() {
    // Decrypt the app's variables now, at execution time. Secrets are never in the job payload.
    let appEnv;
    try {
      appEnv = await loadEnv(db.pool, d.appId, secretsKey);
    } catch (err) {
      // Only our own EnvDecryptError message is known to be safe to store; anything else gets a generic one.
      const message = err instanceof EnvDecryptError ? err.message : 'Could not load the app variables';
      log(`Deployment failed: ${message}`);
      await db.markFailed(id, message).catch(tolerate('failure'));
      throw new Error(message);
    }

    // Record the variable versions this deployment ACTUALLY uses (the API's snapshot was taken at queue time).
    await db.recordEnvVersions(id, appEnv.versions).catch(tolerate('env versions'));

    // How git will authenticate: anonymously for public repositories, or with a short-lived token scoped to this
    // one repository. The token lives only in memory and only reaches git's environment, never docker or the container.
    let gitEnv;
    try {
      // The GitHub client can be a function: the apps are connected in the dashboard, so ask now, not at startup. Each project is assigned
      // to one GitHub App (none: public repositories only).
      const githubClient = typeof github === 'function' ? await github(d.githubAppId) : github;
      ({ gitEnv } = await resolveGitAuth({
        github: githubClient, db, installationId: d.installationId, appId: d.appId, repoFullName: d.repoFullName, log,
      }));
    } catch (err) {
      const message = err instanceof GitAuthError ? err.message : 'Could not prepare GitHub access';
      log(`Deployment failed: ${message}`);
      await db.markFailed(id, message).catch(tolerate('failure'));
      throw new Error(message);
    }
    redact = createRedactor([...valuesOf(appEnv.env), ...valuesOf(appEnv.buildEnv), ...valuesOf(appEnv.buildSecretEnv ?? []), ...secretsFromGitEnv(gitEnv)]);

    // Watch for a cancel request while the deployment runs: one cheap query per tick, only while active.
    const controller = new AbortController();
    let requested = null;
    let polling = false;
    let timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const flag = await db.getCancelStatus(id);
        if (flag && !requested) {
          requested = flag;
          log(`Stop requested (${flag}); stopping the deployment`);
          controller.abort();
        }
      } catch { /* a missed poll is retried on the next tick */ } finally {
        polling = false;
      }
    }, pollMs);
    const stopWatching = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };

    // Called by deploy() right before the swap. After a "proceed", cancellation is ignored. The app's wish is read
    // HERE, not when the deployment was requested, so a Stop pressed during a long build is still honoured.
    const beforeSwap = async () => {
      let start;
      try {
        const flag = requested ?? (await db.getCancelStatus(id));
        if (flag) return { proceed: false, outcome: flag };
        const newer = await db.newerSuccess(id);
        if (newer) return { proceed: false, outcome: 'superseded', by: newer };
        start = d.startAfterDeploy === true || (await db.getDesiredState(d.appId)) !== 'stopped';
      } catch {
        throw new Error('Could not check for a cancel request'); // generic: never pass database internals along
      }
      stopWatching();
      return { proceed: true, start };
    };

    // Progress reports from deploy() are fire-and-forget. Queue their writes so they are applied IN ORDER and
    // always finish before the final status is written (otherwise a late "validating" or a missing commit hash
    // could survive into the finished record).
    let writes = Promise.resolve();
    const inOrder = (label, fn) => { writes = writes.then(fn).catch(tolerate(label)); };

    let result;
    try {
      result = await deployFn({
        ...d,
        env: appEnv.env,
        buildEnv: appEnv.buildEnv ?? [], // only for `docker build`; never given to the container
        buildSecretEnv: appEnv.buildSecretEnv ?? [], // the same, as BuildKit secrets
        gitEnv,
        log,
        logSink: sink ?? undefined,
        // Before the old version's container is removed, save the rest of its output.
        onRetire: collector ? (container) => collector.drain(container, { appId: d.appId }) : undefined,
        signal: controller.signal,
        beforeSwap,
        onStatus: (s) => inOrder(s, () => db.setStatus(id, s)),
        onCommit: (sha) => inOrder('commit', () => db.setCommit(id, sha)),
      });
    } catch {
      stopWatching();
      await writes;
      log('Deployment failed: unexpected error');
      await db.markFailed(id, 'Unexpected error while deploying').catch(tolerate('failure'));
      throw new Error('Unexpected error while deploying');
    } finally {
      stopWatching();
    }
    await writes; // every progress write is done before any final status

    if (result.ok) {
      log('Deployment succeeded');
      await db.markSucceeded(id, result.image, result.imageBytes ?? null).catch(tolerate('success'));
      // What the live container is doing now. An explicit "deploy and start" is what finally turns the wish to running.
      const started = result.started !== false;
      if (d.startAfterDeploy === true && started) await db.setDesiredState(d.appId, 'running').catch(tolerate('desired state'));
      // A new version going live also forgives earlier crashes: they belonged to the old one.
      await db.setRuntime(d.appId, { state: started ? 'running' : 'stopped', action: 'deploy', error: null, resetCrashes: started }).catch(tolerate('runtime'));
      // Clean-up after a deployment is the app's own choice (off by default). It runs here, in this job's turn on the
      // queue, so it can never meet another deployment; and a failure must not turn a successful deployment into a failed one.
      try {
        const app = await db.getApp(d.appId);
        if (app?.auto_prune) await pruneFn({ appId: d.appId, trigger: 'auto' }, { log });
      } catch (err) {
        log(`Automatic clean-up failed: ${err.message}`);
      }
      return { deploymentId: result.deploymentId, image: result.image };
    }

    if (result.stopped) {
      // Stopped on request: not a failure, so the job completes normally.
      const outcome = result.outcome ?? requested ?? 'cancelled';
      log(`Deployment stopped: ${outcome}`);
      await db.markStopped(id, outcome, result.by ?? null).catch(tolerate('stop'));
      return { deploymentId: id, outcome };
    }

    log(`Deployment failed: ${result.error}`);
    await db.markFailed(id, result.error).catch(tolerate('failure'));
    throw new Error(result.error); // marks the BullMQ job failed
  }
}
