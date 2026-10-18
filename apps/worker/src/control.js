// Start / stop / restart of an app's live container. Runs as a job on the same queue as deployments, one at a time,
// so it can never overlap a swap. The API has already recorded what the administrator wants (apps.desired_state);
// this carries it out and records what actually happened in app_runtime.
//
// Stopping keeps everything (container, image, config, volumes). Starting and restarting never rebuild.
import * as realEngine from './docker.js';
import * as store from './db.js';

export const ACTIONS = ['start', 'stop', 'restart'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @returns {Promise<{ok: true, skipped?: true} | {ok: false, error: string}>}
 */
export async function controlApp({ appId, action }, { eng = realEngine, db = store, log = console.log } = {}) {
  const app = await db.getApp(appId);
  if (!app) {
    log(`Skipped ${action}: the app no longer exists`);
    return { ok: true, skipped: true };
  }

  const fail = async (message) => {
    // A failed action changes nothing about the container, so the recorded state is left as it was.
    await db.setRuntime(appId, { action, error: message });
    log(`${action} failed: ${message}`);
    return { ok: false, error: message };
  };

  const containers = await eng.findContainers({ appId, role: 'live' });
  if (!containers.length) return fail('Nothing is deployed for this app yet. Deploy it first.');

  try {
    if (action === 'stop') {
      for (const c of containers) await eng.stopContainer(c);
      await db.setRuntime(appId, { state: 'stopped', action, error: null });
      log(`Stopped ${app.slug}`);
      return { ok: true };
    }

    for (const c of containers) {
      if (action === 'restart') await eng.restartContainer(c);
      else await eng.startContainer(c);
    }
  } catch (err) {
    return fail(String(err.message ?? err));
  }

  // Started: now see whether it really came up. An app that does not pass its health check is reported unhealthy and
  // left running for the administrator to look at; it is never stopped or restarted automatically.
  try {
    for (const c of containers) await eng.waitHealthy(c, { containerPort: app.container_port, health: app.health_path ?? undefined });
  } catch (err) {
    const message = `Started, but it did not pass its health check: ${err.message}`;
    await db.setRuntime(appId, { state: 'unhealthy', action, error: message });
    log(`${app.slug}: ${message}`);
    return { ok: true };
  }
  await db.setRuntime(appId, { state: 'running', action, error: null });
  log(`${action === 'restart' ? 'Restarted' : 'Started'} ${app.slug}`);
  return { ok: true };
}

/** The BullMQ job: validate the payload, do the work, fail the job if the action failed. */
export async function processControlJob(job, deps = {}) {
  const { appId, action } = job.data ?? {};
  if (!ACTIONS.includes(action)) throw new Error('Control job has an unknown action');
  if (typeof appId !== 'string' || !UUID_RE.test(appId)) throw new Error('Control job is missing a valid app id');

  const log = (msg) => {
    console.log(`[job ${job.id}] ${msg}`);
    Promise.resolve(job.log?.(msg)).catch(() => {});
  };
  const result = await controlApp({ appId, action }, { ...deps, log });
  if (!result.ok) throw new Error(result.error); // marks the job failed; the reason is also in app_runtime
  return { appId, action };
}
