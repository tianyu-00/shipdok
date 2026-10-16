// The body of a deploy job, separated from worker.js so it can be tested without Redis or Docker.
import { deploy } from './deploy.js';
import * as store from './db.js';
import { loadAppEnv, EnvDecryptError } from './envvars.js';

// Status updates are best-effort: a database hiccup must not abort a deployment mid-swap.
const tolerate = (label) => (err) => console.error(`Could not record ${label}: ${err.message}`);

export async function processDeployJob(job, { secretsKey, deployFn = deploy, db = store, loadEnv = loadAppEnv }) {
  const d = job.data;
  const id = d.deploymentId;
  if (!id || !d.appId) throw new Error('Deploy job is missing deploymentId or appId');

  const log = (msg) => {
    console.log(`[job ${job.id}] ${msg}`);
    Promise.resolve(job.log(msg)).catch(() => {}); // kept in Redis for now; real log storage comes later
  };

  await db.markBuilding(id).catch(tolerate('building'));

  // Decrypt the app's variables now, at execution time. Secrets are never in the job payload.
  let appEnv;
  try {
    appEnv = await loadEnv(db.pool, d.appId, secretsKey);
  } catch (err) {
    // Only our own EnvDecryptError message is known to be safe to store; anything else gets a generic one.
    const message = err instanceof EnvDecryptError ? err.message : 'Could not load the app variables';
    await db.markFailed(id, message).catch(tolerate('failure'));
    throw new Error(message);
  }

  // Record the variable versions this deployment ACTUALLY uses (the API's snapshot was taken at queue time).
  await db.recordEnvVersions(id, appEnv.versions).catch(tolerate('env versions'));

  const result = await deployFn({
    ...d,
    env: appEnv.env,
    log,
    onStatus: (s) => db.setStatus(id, s).catch(tolerate(s)),
    onCommit: (sha) => db.setCommit(id, sha).catch(tolerate('commit')),
  });

  if (result.ok) await db.markSucceeded(id, result.image).catch(tolerate('success'));
  else await db.markFailed(id, result.error).catch(tolerate('failure'));

  if (!result.ok) throw new Error(result.error); // marks the BullMQ job failed
  return { deploymentId: result.deploymentId, image: result.image };
}
