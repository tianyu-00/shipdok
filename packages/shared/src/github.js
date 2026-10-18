// GitHub App authentication, shared by the API (installation lookup, repo listing) and the worker (clone tokens).
//
//   private key  --signs-->  short-lived app JWT  --exchanged for-->  installation token (about 1 hour)
//
// Secrets: the private key and tokens are never logged and never appear in error messages. Errors carry
// only a status code. Installation tokens used for cloning are scoped to ONE repository, read-only.
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
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

// ---------------------------------------------------------------- configuration

/**
 * Reads the GitHub App settings from the environment.
 * Returns null when nothing is set (public repositories only), throws a clear error when the settings are
 * partial or wrong, and never puts key material in a message.
 *   GITHUB_APP_ID                numeric App ID from the app's settings page
 *   GITHUB_APP_PRIVATE_KEY_FILE  path to the downloaded .pem (recommended; keep it chmod 600)
 *   GITHUB_APP_PRIVATE_KEY       the PEM itself, with \n for newlines (alternative)
 */
export function loadGithubAppConfig(env = process.env, io = { readFileSync, statSync }) {
  const appId = env.GITHUB_APP_ID?.trim();
  const keyFile = env.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  const keyInline = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId && !keyFile && !keyInline) return null;

  if (!appId || !/^\d+$/.test(appId)) {
    throw new Error('GITHUB_APP_ID must be the numeric App ID shown on the GitHub App settings page');
  }
  if (!keyFile && !keyInline) {
    throw new Error('GITHUB_APP_PRIVATE_KEY_FILE (the path to the .pem file) is required when GITHUB_APP_ID is set');
  }
  if (keyFile && keyInline) {
    throw new Error('Set only one of GITHUB_APP_PRIVATE_KEY_FILE and GITHUB_APP_PRIVATE_KEY');
  }

  const warnings = [];
  let pem;
  if (keyFile) {
    try {
      pem = io.readFileSync(keyFile, 'utf8');
    } catch {
      throw new Error(`Could not read GITHUB_APP_PRIVATE_KEY_FILE (${keyFile})`);
    }
    if (io.statSync(keyFile).mode & 0o077) warnings.push(`${keyFile} can be read by other users; run: chmod 600 ${keyFile}`);
  } else {
    pem = keyInline.replace(/\\n/g, '\n');
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new Error('The GitHub App private key is not a valid PEM private key');
  }
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('The GitHub App private key must be an RSA key');
  return { appId, privateKey, warnings };
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

  async function api(path, { method = 'GET', bearer, body, okStatuses = [] } = {}) {
    let res;
    try {
      res = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'shipdok',
          Authorization: `Bearer ${bearer}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GithubError('Could not reach GitHub', undefined);
    }
    if (!res.ok && !okStatuses.includes(res.status)) {
      // Deliberately no response body and no request details: only the status.
      throw new GithubError(`GitHub API request failed (HTTP ${res.status})`, res.status);
    }
    let json = null;
    if (res.ok) {
      try { json = await res.json(); } catch { throw new GithubError('GitHub sent an unreadable response', res.status); }
    }
    return { status: res.status, json, link: res.headers?.get?.('link') ?? null };
  }

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
      return { id: json.id, slug: json.slug, name: json.name, htmlUrl: json.html_url };
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
