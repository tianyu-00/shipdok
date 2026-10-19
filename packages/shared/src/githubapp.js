// The GitHub App Shipdok uses, kept in the database (one row) and shared by the API and the worker.
//
// The private key, the webhook secret and the client secret are encrypted with the platform key; each is bound to its own field
// name, so a ciphertext copied into another field fails to decrypt. The plain part (app id, name, owner, links) is information.
// Nothing here logs, returns or throws a secret.
import { decryptSecret, encryptSecret } from './crypto.js';
import { createGithubClient, parsePrivateKeyPem } from './github.js';

export const githubFieldContext = (field) => `github:${field}`;

export class GithubStoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GithubStoreError';
    this.code = code;
  }
}

const PLAIN = 'app_id, slug, name, owner_login, html_url, client_id, source, created_at, updated_at';

const summaryOf = (row) => ({
  appId: String(row.app_id),
  slug: row.slug,
  name: row.name,
  ownerLogin: row.owner_login,
  htmlUrl: row.html_url,
  clientId: row.client_id,
  source: row.source,
  connectedAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Save (replace) the app. `privateKeyPem` must already be valid: the caller has checked it works. */
export async function saveGithubApp(db, key, a) {
  const enc = (field, value) => encryptSecret(value, key, githubFieldContext(field));
  await db.query(
    `INSERT INTO github_app (id, app_id, slug, name, owner_login, html_url, client_id, private_key_enc, webhook_secret_enc, client_secret_enc, source)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET app_id = $1, slug = $2, name = $3, owner_login = $4, html_url = $5, client_id = $6,
       private_key_enc = $7, webhook_secret_enc = $8, client_secret_enc = $9, source = $10, created_at = now(), updated_at = now()`,
    [
      a.appId, a.slug ?? null, a.name ?? null, a.ownerLogin ?? null, a.htmlUrl ?? null, a.clientId ?? null,
      enc('private_key', a.privateKeyPem), enc('webhook_secret', a.webhookSecret),
      a.clientSecret ? enc('client_secret', a.clientSecret) : null, a.source,
    ],
  );
}

/** The plain information about the app, or null when none is connected. No secrets, no decryption. */
export async function githubAppSummary(db) {
  const { rows } = await db.query(`SELECT ${PLAIN} FROM github_app WHERE id = 1`);
  return rows[0] ? summaryOf(rows[0]) : null;
}

/** The app with its secrets decrypted, or null. Throws GithubStoreError('cannot_decrypt') if the platform key does not fit. */
export async function loadGithubApp(db, key) {
  const { rows } = await db.query(`SELECT ${PLAIN}, private_key_enc, webhook_secret_enc FROM github_app WHERE id = 1`);
  const row = rows[0];
  if (!row) return null;
  try {
    const privateKeyPem = decryptSecret(row.private_key_enc, key, githubFieldContext('private_key'));
    const webhookSecret = decryptSecret(row.webhook_secret_enc, key, githubFieldContext('webhook_secret'));
    return { ...summaryOf(row), privateKey: parsePrivateKeyPem(privateKeyPem), webhookSecret };
  } catch {
    throw new GithubStoreError('The stored GitHub App credentials cannot be read (was APP_SECRETS_KEY changed?)', 'cannot_decrypt');
  }
}

export async function deleteGithubApp(db) {
  const { rowCount } = await db.query('DELETE FROM github_app WHERE id = 1');
  return rowCount === 1;
}

/**
 * What the API and the worker ask: the GitHub client, the webhook secret, a summary. Reads the database at most every `ttlMs`, so a
 * change made in the dashboard reaches the other process within seconds without a restart. A client is built once per saved version,
 * which keeps its token cache.
 */
export function createGithubProvider(db, key, { ttlMs = 5000, fetch, apiBase, now = () => Date.now(), onProblem = () => {} } = {}) {
  let cache = null; // { at, app, problem, client }

  async function state() {
    if (cache && now() - cache.at < ttlMs) return cache;
    let app = null;
    let problem = null;
    try {
      app = await loadGithubApp(db, key);
    } catch (err) {
      if (!(err instanceof GithubStoreError)) {
        // the database is unreachable: keep what was known
        if (cache) return cache;
        throw err;
      }
      problem = err.code;
      onProblem(err);
    }
    const same = cache?.app && app && cache.app.updatedAt?.getTime?.() === app.updatedAt?.getTime?.() && cache.app.appId === app.appId;
    const client = app ? (same ? cache.client : createGithubClient({ appId: app.appId, privateKey: app.privateKey, ...(fetch ? { fetch } : {}), ...(apiBase ? { apiBase } : {}) })) : null;
    cache = { at: now(), app, problem, client };
    return cache;
  }

  return {
    /** A client for the connected app, or null (nothing connected, or the credentials cannot be read). */
    async client() { return (await state()).client; },
    async webhookSecret() { return (await state()).app?.webhookSecret ?? null; },
    /** { app: summary|null, problem: 'cannot_decrypt'|null } */
    async status() {
      const { app, problem } = await state();
      return { app: app ? (({ privateKey: _k, webhookSecret: _s, ...plain }) => plain)(app) : null, problem };
    },
    invalidate() { cache = null; },
  };
}

const OLD_ENV = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'];

/**
 * The GitHub App used to be set in the environment. It is entered in the dashboard now and these are no longer read: a line for the
 * log (or null) so that nobody wonders why their old settings do nothing. Names only, never values.
 */
export function oldGithubEnvNotice(env = process.env) {
  const set = OLD_ENV.filter((name) => env[name] && String(env[name]).trim());
  if (set.length === 0) return null;
  return `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set but no longer read: connect GitHub on the GitHub page of the dashboard instead (then remove ${set.length === 1 ? 'it' : 'them'} from the environment).`;
}
