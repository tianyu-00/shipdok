// GitHub App authentication, shared by the API (installation lookup, repo listing) and the worker (clone tokens).
//
//   private key  --signs-->  short-lived app JWT  --exchanged for-->  installation token (about 1 hour)
//
// Secrets: the private key and tokens are never logged and never appear in error messages. Errors carry
// only a status code. Installation tokens used for cloning are scoped to ONE repository, read-only.
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { REPO_FULL_NAME_RE } from './constants.js';

const REPO_NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/; // a bare repository name, never `.` or `..`

// 'owner/name' -> { owner, name }, or null if it is not a safe GitHub repository name
const parseRepo = (full) => {
  if (typeof full !== 'string' || !REPO_FULL_NAME_RE.test(full)) return null;
  const [owner, name] = full.split('/');
  return { owner, name };
};
const MAX_PAGES = 10;

export class GithubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
  }
}

// ---------------------------------------------------------------- the private key

/**
 * The private key as GitHub hands it out (a PEM text; GitHub's download is PKCS#1, "BEGIN RSA PRIVATE KEY"), as a key object.
 * Throws a clear error that never contains key material. Surrounding spaces and Windows line endings are tolerated.
 */
export function parsePrivateKeyPem(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The private key is empty');
  let key;
  try {
    key = createPrivateKey(text.trim().replace(/\r\n/g, '\n'));
  } catch {
    throw new Error('The private key is not a valid PEM private key');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('The GitHub App private key must be an RSA key');
  return key;
}

// ---------------------------------------------------------------- app JWT

const b64url = (data) => Buffer.from(data).toString('base64url');

/** A short-lived token proving we are the app. GitHub allows at most 10 minutes; we use 9 and backdate iat by 60s for clock drift. */
export function signAppJwt({ appId, privateKey, now = Date.now() }) {
  const seconds = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: String(appId) }));
  const signature = cryptoSign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

// ---------------------------------------------------------------- client

function nextPath(linkHeader, apiBase) {
  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader ?? '');
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    // Only ever follow links back to the same API host: a Link header must not redirect us (and our token) elsewhere.
    return url.origin === new URL(apiBase).origin ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

/**
 * One call to GitHub's API. A `bearer` token is optional: without one the call is anonymous, which works for public repositories only.
 * Deliberately no response body and no request details in an error: only the status.
 */
async function githubApi({ fetch, apiBase }, path, { method = 'GET', bearer, body, okStatuses = [] } = {}) {
  let res;
  try {
    res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'shipdok',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GithubError('Could not reach GitHub', undefined);
  }
  if (!res.ok && !okStatuses.includes(res.status)) {
    throw new GithubError(`GitHub API request failed (HTTP ${res.status})`, res.status);
  }
  let json = null;
  if (res.ok) {
    try { json = await res.json(); } catch { throw new GithubError('GitHub sent an unreadable response', res.status); }
  }
  return { status: res.status, json, link: res.headers?.get?.('link') ?? null };
}

const BRANCH_PAGES = 5; // 100 per page: the first 500 branches

/**
 * The branches of a repository and its default branch. With a `bearer` (an installation token) private repositories work too; without one only
 * public repositories do. The default branch comes first, the rest in alphabetical order. `truncated` is true when there were more than we read.
 * @returns {Promise<{ defaultBranch: string|null, branches: string[], truncated: boolean }>}
 * Throws GithubError (status 404: no such repository, or a private one the token cannot see; 403/429: rate limited).
 */
export async function listRepoBranches(fullName, { bearer, fetch = globalThis.fetch, apiBase = 'https://api.github.com' } = {}) {
  const parsed = parseRepo(fullName);
  if (!parsed) throw new TypeError('Invalid repository name');
  const env = { fetch, apiBase };
  const repoPath = `/repos/${parsed.owner}/${parsed.name}`;
  const { json: repo } = await githubApi(env, repoPath, { bearer });
  const names = [];
  let path = `${repoPath}/branches?per_page=100`;
  for (let page = 0; path && page < BRANCH_PAGES; page++) {
    const { json, link } = await githubApi(env, path, { bearer });
    for (const b of Array.isArray(json) ? json : []) if (typeof b?.name === 'string' && b.name) names.push(b.name);
    path = nextPath(link, apiBase);
  }
  const defaultBranch = typeof repo?.default_branch === 'string' && repo.default_branch ? repo.default_branch : null;
  const rest = [...new Set(names)].filter((n) => n !== defaultBranch).sort((a, b) => a.localeCompare(b));
  return { defaultBranch, branches: defaultBranch && names.includes(defaultBranch) ? [defaultBranch, ...rest] : rest, truncated: path !== null };
}

/**
 * Can the repository be seen, and what is it? For the first step of creating an app: one request, nothing about what is inside it.
 * Anonymous works for a public repository; with a token it also sees the private one that token is for.
 * @returns {Promise<{ fullName: string, private: boolean, defaultBranch: string|null }>}
 * Throws GithubError (status 404: no such repository, or a private one the token cannot see; 403/429: rate limited).
 */
export async function inspectRepo(fullName, { bearer, fetch = globalThis.fetch, apiBase = 'https://api.github.com' } = {}) {
  const parsed = parseRepo(fullName);
  if (!parsed) throw new TypeError('Invalid repository name');
  const { json: repo } = await githubApi({ fetch, apiBase }, `/repos/${parsed.owner}/${parsed.name}`, { bearer });
  return {
    fullName: typeof repo?.full_name === 'string' && repo.full_name ? repo.full_name : fullName,
    private: Boolean(repo?.private),
    defaultBranch: typeof repo?.default_branch === 'string' && repo.default_branch ? repo.default_branch : null,
  };
}

export function createGithubClient({
  appId,
  privateKey,
  fetch = globalThis.fetch,
  apiBase = 'https://api.github.com',
  now = () => Date.now(),
  refreshMarginMs = 5 * 60_000,
} = {}) {
  const tokenCache = new Map(); // key -> { token, expiresAt }
  const inFlight = new Map(); // key -> Promise<string>

  const api = (path, opts) => githubApi({ fetch, apiBase }, path, opts);

  const appJwt = () => signAppJwt({ appId, privateKey, now: now() });

  async function pages(firstPath, bearerFor, pick) {
    const items = [];
    let path = firstPath;
    for (let page = 0; path && page < MAX_PAGES; page++) {
      const { json, link } = await api(path, { bearer: await bearerFor() });
      items.push(...pick(json));
      path = nextPath(link, apiBase);
    }
    return items;
  }

  const client = {
    /** The app's own details; also a cheap way to check the credentials work. */
    async getApp() {
      const { json } = await api('/app', { bearer: appJwt() });
      return { id: json.id, slug: json.slug, name: json.name, htmlUrl: json.html_url, ownerLogin: json.owner?.login ?? null };
    },

    /** The address GitHub sends this app's webhooks to (null if none is set). The secret is never read back. */
    async getWebhookConfig() {
      const { json } = await api('/app/hook/config', { bearer: appJwt() });
      return { url: typeof json?.url === 'string' && json.url ? json.url : null };
    },

    /** Point the app's webhooks at a new address. Only the address is sent: the secret and the rest stay as they are. */
    async updateWebhookUrl(url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw new TypeError('Invalid webhook address'); }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new TypeError('Invalid webhook address');
      await api('/app/hook/config', { method: 'PATCH', bearer: appJwt(), body: { url: parsed.toString() } });
    },

    /**
     * A token for an installation. For cloning, pass { repo } to get one that can read ONLY that repository.
     * Tokens are cached until 5 minutes before they expire, and concurrent callers share one request.
     */
    async getInstallationToken(installationId, { repo, permissions } = {}) {
      const id = Number(installationId);
      if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('Invalid installation id');
      let repoName;
      if (repo !== undefined) {
        const parsed = parseRepo(repo);
        repoName = parsed ? parsed.name : REPO_NAME_RE.test(repo) ? repo : null;
        if (!repoName) throw new TypeError('Invalid repository name');
      }
      const key = `${id}|${repoName ?? '*'}|${permissions ? JSON.stringify(permissions) : ''}`;

      const cached = tokenCache.get(key);
      if (cached && cached.expiresAt - now() > refreshMarginMs) return cached.token;
      if (inFlight.has(key)) return inFlight.get(key);

      const request = (async () => {
        const body = repoName || permissions
          ? { ...(repoName ? { repositories: [repoName] } : {}), ...(permissions ? { permissions } : {}) }
          : undefined;
        const { json } = await api(`/app/installations/${id}/access_tokens`, { method: 'POST', bearer: appJwt(), body });
        const expiresAt = Date.parse(json?.expires_at);
        if (typeof json?.token !== 'string' || !json.token || Number.isNaN(expiresAt)) {
          throw new GithubError('GitHub sent an unexpected access token response', 200);
        }
        tokenCache.set(key, { token: json.token, expiresAt });
        return json.token;
      })().finally(() => inFlight.delete(key)); // a failure is never cached
      inFlight.set(key, request);
      return request;
    },

    /** The installation covering a repository, or null if the app is not installed there (or cannot see it). */
    async findInstallationForRepo(fullName) {
      const parsed = parseRepo(fullName);
      if (!parsed) throw new TypeError('Invalid repository name');
      const { status, json } = await api(`/repos/${parsed.owner}/${parsed.name}/installation`, { bearer: appJwt(), okStatuses: [404] });
      return status === 404 ? null : Number(json.id);
    },

    /**
     * The branches of a repository: through the app's installation when it is installed there (a token for this one repository, read-only),
     * otherwise anonymously, which works for public repositories.
     */
    async listBranches(fullName) {
      const id = await client.findInstallationForRepo(fullName);
      if (id === null) return listRepoBranches(fullName, { fetch, apiBase });
      const token = await client.getInstallationToken(id, { repo: fullName, permissions: { contents: 'read' } });
      return listRepoBranches(fullName, { bearer: token, fetch, apiBase });
    },

    /** Can the repository be seen, and what is it (see inspectRepo): through the app's installation when it is installed there, otherwise anonymously (public repositories). */
    async inspectRepo(fullName) {
      const id = await client.findInstallationForRepo(fullName);
      if (id === null) return { ...(await inspectRepo(fullName, { fetch, apiBase })), via: 'anonymous' };
      const token = await client.getInstallationToken(id, { repo: fullName, permissions: { contents: 'read' } });
      return { ...(await inspectRepo(fullName, { bearer: token, fetch, apiBase })), via: 'app' };
    },

    async listInstallations() {
      const items = await pages('/app/installations?per_page=100', async () => appJwt(),
        (json) => json.map((i) => ({ id: Number(i.id), account: i.account?.login ?? null })));
      return items;
    },

    async listInstallationRepos(installationId) {
      const token = await client.getInstallationToken(installationId);
      return pages('/installation/repositories?per_page=100', async () => token,
        (json) => (json.repositories ?? []).map((r) => ({ fullName: r.full_name, private: Boolean(r.private), defaultBranch: r.default_branch ?? null })));
    },

    /** Every repository the app can see, across all of its installations. */
    async listAllRepos() {
      const out = [];
      for (const inst of await client.listInstallations()) {
        for (const repo of await client.listInstallationRepos(inst.id)) out.push({ ...repo, installationId: inst.id });
      }
      return out;
    },
  };
  return client;
}

// ---------------------------------------------------------------- the manifest flow

const MANIFEST_CODE_RE = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * The last step of "Connect GitHub": GitHub gives the browser a one-time code, and this trades it for the app's credentials. It is an
 * outbound call with no login, so it works from localhost. The code can be used once and only briefly. Returns what is to be stored
 * (the private key as PEM text); errors carry only a status, never the answer.
 */
export async function exchangeManifestCode(code, { fetch = globalThis.fetch, apiBase = 'https://api.github.com' } = {}) {
  if (typeof code !== 'string' || !MANIFEST_CODE_RE.test(code)) throw new TypeError('Invalid manifest code');
  let res;
  try {
    res = await fetch(`${apiBase}/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'shipdok' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GithubError('Could not reach GitHub', undefined);
  }
  if (!res.ok) throw new GithubError(`GitHub API request failed (HTTP ${res.status})`, res.status);
  let json;
  try { json = await res.json(); } catch { throw new GithubError('GitHub sent an unreadable response', res.status); }
  const unusable = () => new GithubError('GitHub sent an unexpected app description', res.status);
  const id = json?.id;
  if (!(Number.isSafeInteger(id) && id > 0) && !(typeof id === 'string' && /^\d{1,20}$/.test(id))) throw unusable();
  if (typeof json.webhook_secret !== 'string' || !json.webhook_secret) throw unusable();
  try { parsePrivateKeyPem(json.pem); } catch { throw unusable(); }
  return {
    appId: String(id),
    slug: typeof json.slug === 'string' ? json.slug : null,
    name: typeof json.name === 'string' ? json.name : null,
    htmlUrl: typeof json.html_url === 'string' ? json.html_url : null,
    ownerLogin: json.owner?.login ?? null,
    clientId: typeof json.client_id === 'string' ? json.client_id : null,
    clientSecret: typeof json.client_secret === 'string' && json.client_secret ? json.client_secret : null,
    webhookSecret: json.webhook_secret,
    privateKeyPem: json.pem,
  };
}

// ---------------------------------------------------------------- git

/**
 * Environment variables that make git send the token as an HTTP header, for the git commands that talk to GitHub.
 * An environment, not a command-line argument: arguments are visible to every user through `ps`.
 * Pass this ONLY to git, never to `docker build` or into a container.
 */
export function gitAuthEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0', // fail instead of waiting for a password nobody will type
  };
}
