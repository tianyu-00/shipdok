// The GitHub Apps Shipdok uses, kept in the database (one row each) and shared by the API and the worker.
//
// The private key, the webhook secret and the client secret are encrypted with the platform key; each is bound to its own field
// name AND to the row's id, so a ciphertext copied into another field or another app fails to decrypt. (The one app that was connected
// before there could be several was encrypted for the field name alone: its row says `legacy_context` and stays readable that way until
// it is saved again.) The plain part (app id, name, owner, links) is information.
// Nothing here logs, returns or throws a secret.
import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret } from './crypto.js';
import { createGithubClient, parsePrivateKeyPem } from './github.js';

export const githubFieldContext = (field, id) => (id ? `github:${id}:${field}` : `github:${field}`);

export class GithubStoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GithubStoreError';
    this.code = code;
  }
}

const PLAIN = 'id, app_id, slug, name, owner_login, html_url, client_id, source, created_at, updated_at';

const summaryOf = (row) => ({
  id: row.id,
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

/**
 * Save an app. `privateKeyPem` must already be valid: the caller has checked it works. GitHub's number for the app is unique, so saving
 * an app that is already connected REPLACES its credentials (same id, same projects). Returns { id, created }.
 */
export async function saveGithubApp(db, key, a) {
  const existing = (await db.query('SELECT id FROM github_apps WHERE app_id = $1', [a.appId])).rows[0];
  const id = existing?.id ?? randomUUID();
  const enc = (field, value) => encryptSecret(value, key, githubFieldContext(field, id));
  await db.query(
    `INSERT INTO github_apps (id, app_id, slug, name, owner_login, html_url, client_id, private_key_enc, webhook_secret_enc, client_secret_enc, source, legacy_context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)
     ON CONFLICT (app_id) DO UPDATE SET slug = $3, name = $4, owner_login = $5, html_url = $6, client_id = $7,
       private_key_enc = $8, webhook_secret_enc = $9, client_secret_enc = $10, source = $11, legacy_context = false, updated_at = now()`,
    [
      id, a.appId, a.slug ?? null, a.name ?? null, a.ownerLogin ?? null, a.htmlUrl ?? null, a.clientId ?? null,
      enc('private_key', a.privateKeyPem), enc('webhook_secret', a.webhookSecret),
      a.clientSecret ? enc('client_secret', a.clientSecret) : null, a.source,
    ],
  );
  return { id, created: !existing };
}

/** The plain information about every connected app (oldest first). No secrets, no decryption. */
export async function listGithubApps(db) {
  const { rows } = await db.query(`SELECT ${PLAIN} FROM github_apps ORDER BY created_at, id`);
  return rows.map(summaryOf);
}

/** The plain information about one app, or null. No secrets, no decryption. */
export async function githubAppSummary(db, id) {
  const { rows } = await db.query(`SELECT ${PLAIN} FROM github_apps WHERE id = $1`, [id]);
  return rows[0] ? summaryOf(rows[0]) : null;
}

function decryptRow(row, key) {
  const ctx = (field) => githubFieldContext(field, row.legacy_context ? undefined : row.id);
  try {
    const privateKeyPem = decryptSecret(row.private_key_enc, key, ctx('private_key'));
    const webhookSecret = decryptSecret(row.webhook_secret_enc, key, ctx('webhook_secret'));
    return { ...summaryOf(row), privateKey: parsePrivateKeyPem(privateKeyPem), webhookSecret };
  } catch {
    throw new GithubStoreError('The stored GitHub App credentials cannot be read (was APP_SECRETS_KEY changed?)', 'cannot_decrypt');
  }
}

const WITH_SECRETS = `${PLAIN}, private_key_enc, webhook_secret_enc, legacy_context`;

/** One app with its secrets decrypted, or null. Throws GithubStoreError('cannot_decrypt') if the platform key does not fit. */
export async function loadGithubApp(db, key, id) {
  const { rows } = await db.query(`SELECT ${WITH_SECRETS} FROM github_apps WHERE id = $1`, [id]);
  return rows[0] ? decryptRow(rows[0], key) : null;
}

/** Every app. One whose credentials cannot be read is still listed, with `problem: 'cannot_decrypt'` and no secrets. */
export async function loadGithubApps(db, key) {
  const { rows } = await db.query(`SELECT ${WITH_SECRETS} FROM github_apps ORDER BY created_at, id`);
  return rows.map((row) => {
    try {
      return decryptRow(row, key);
    } catch (err) {
      return { ...summaryOf(row), problem: err.code };
    }
  });
}

/**
 * Forget an app. The projects assigned to it keep running; they are left with no GitHub App and no remembered installation.
 * Returns the projects that were using it ([] if none) or null when there is no such app.
 */
export async function deleteGithubApp(db, id) {
  const { rows: used } = await db.query('SELECT id, name, slug FROM apps WHERE github_app_id = $1 ORDER BY name', [id]);
  await db.query('UPDATE apps SET github_installation_id = NULL, github_app_id = NULL WHERE github_app_id = $1', [id]);
  const { rowCount } = await db.query('DELETE FROM github_apps WHERE id = $1', [id]);
  return rowCount === 1 ? used : null;
}

/**
 * What the API and the worker ask: a GitHub client for a given app, the webhook secrets, a status. Reads the database at most every
 * `ttlMs`, so a change made in the dashboard reaches the other process within seconds without a restart. A client is built once per
 * saved version of an app, which keeps its token cache.
 */
export function createGithubProvider(db, key, { ttlMs = 5000, fetch, apiBase, now = () => Date.now(), onProblem = () => {} } = {}) {
  let cache = null; // { at, apps: [app...], clients: Map(id -> { updatedAt, client }) }
  const clients = new Map(); // kept between reads while an app is unchanged

  async function state() {
    if (cache && now() - cache.at < ttlMs) return cache;
    let apps;
    try {
      apps = await loadGithubApps(db, key);
    } catch (err) {
      // the database is unreachable: keep what was known
      if (cache) return cache;
      throw err;
    }
    for (const a of apps) if (a.problem) onProblem(new GithubStoreError('The stored GitHub App credentials cannot be read (was APP_SECRETS_KEY changed?)', a.problem));
    const live = new Set();
    for (const a of apps) {
      if (a.problem) continue;
      live.add(a.id);
      const kept = clients.get(a.id);
      if (kept && kept.updatedAt?.getTime?.() === a.updatedAt?.getTime?.()) continue;
      clients.set(a.id, { updatedAt: a.updatedAt, client: createGithubClient({ appId: a.appId, privateKey: a.privateKey, ...(fetch ? { fetch } : {}), ...(apiBase ? { apiBase } : {}) }) });
    }
    for (const id of [...clients.keys()]) if (!live.has(id)) clients.delete(id);
    cache = { at: now(), apps };
    return cache;
  }

  return {
    /** A client for that app, or null (no such app, or its credentials cannot be read). */
    async client(id) {
      if (!id) return null;
      await state();
      return clients.get(id)?.client ?? null;
    },
    /** Every app whose credentials can be read: [{ id, name, client }]. */
    async clients() {
      const { apps } = await state();
      return apps.filter((a) => clients.has(a.id)).map((a) => ({ id: a.id, name: a.name, client: clients.get(a.id).client }));
    },
    /** [{ id, secret }] of every app whose secret can be read: a webhook is believed if one of them signed it. */
    async webhookSecrets() {
      const { apps } = await state();
      return apps.filter((a) => !a.problem).map((a) => ({ id: a.id, secret: a.webhookSecret }));
    },
    /** { apps: [summary + problem] } with no secrets. */
    async status() {
      const { apps } = await state();
      return { apps: apps.map(({ privateKey: _k, webhookSecret: _s, ...plain }) => ({ problem: null, ...plain })) };
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
