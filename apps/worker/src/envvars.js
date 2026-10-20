// Loads and decrypts an app's environment variables for a deployment.
// Only trusted platform code (the worker) decrypts values, and only at job start.
import { decryptSecret, envVarContext, reachesBuild, reachesRuntime } from '@shipdok/shared';

// The message is safe to store and log: it can name a variable but never contains a value.
export class EnvDecryptError extends Error {}

/**
 * @param {{ query: Function }} db        a pg Pool or client
 * @param {string} appId
 * @param {Buffer} secretsKey             from parseMasterKey(APP_SECRETS_KEY)
 * @returns {Promise<{ env: string[], buildEnv: string[], versions: Record<string, string> }>}
 *   env: ['KEY=value', ...] for the running container (scope runtime or both); buildEnv: the same shape for `docker build` (scope build or both);
 *   versions: { KEY: '<version>' } for EVERY variable, to record on the deployment
 */
export async function loadAppEnv(db, appId, secretsKey) {
  // One query, so values and versions are a consistent snapshot of the same moment.
  const { rows } = await db.query(
    'SELECT key, scope, value_encrypted, version::text AS version FROM app_env_vars WHERE app_id = $1 ORDER BY key',
    [appId],
  );
  const env = [];
  const buildEnv = [];
  const versions = {};
  for (const row of rows) {
    try {
      const pair = `${row.key}=${decryptSecret(row.value_encrypted, secretsKey, envVarContext(appId, row.key))}`;
      if (reachesRuntime(row.scope)) env.push(pair);
      if (reachesBuild(row.scope)) buildEnv.push(pair);
    } catch {
      throw new EnvDecryptError(`Could not decrypt the variable "${row.key}". Check that APP_SECRETS_KEY has not changed.`);
    }
    versions[row.key] = row.version;
  }
  return { env, buildEnv, versions };
}
