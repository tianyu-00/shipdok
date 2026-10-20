import { Router } from 'express';
import { verify } from '@node-rs/argon2';
import { GithubError, createGithubClient, parsePrivateKeyPem, saveGithubApp, deleteGithubApp, listRepoBranches, REPO_FULL_NAME_RE } from '@shipdok/shared';
import { limiter } from '../authutil.js';
import { addressOf, recordAttempt } from '../lockout.js';

// Installation ids belong to one GitHub App. Whenever the app changes (a different one entered, connected or disconnected) the ids remembered
// for each Shipdok app are stale: forget them, and the next deployment looks the installation up again with the app that is connected now.
export const forgetInstallations = (db) => db.query('UPDATE apps SET github_installation_id = NULL WHERE github_installation_id IS NOT NULL');

const BRANCH_CACHE_MS = 60_000;
const BRANCH_CACHE_MAX = 100;

const NOT_CONNECTED = { error: 'GitHub is not connected. Connect it on the GitHub page first.' };

// Never returns a secret: the app's details, repositories and installations only.
export function githubRouter({ db, provider, secretsKey, fetch, settings }) {
  const r = Router();

  async function checkPassword(req, res, password) {
    const { rows } = await db.query('SELECT id, username, password_hash FROM users WHERE id = $1', [req.session.userId]);
    if (!rows[0]) { res.status(401).json({ error: 'Not authenticated' }); return null; }
    let ok = false;
    try { ok = await verify(rows[0].password_hash, password); } catch { ok = false; }
    if (!ok) { res.status(403).json({ error: 'The current password is not correct', code: 'wrong_password' }); return null; }
    return rows[0];
  }

  r.get('/', async (req, res, next) => {
    try {
      const { app, problem } = await provider.status();
      res.json({ connected: Boolean(app), app, problem });
    } catch (err) {
      next(err);
    }
  });

  // Enter an existing GitHub App by hand. The key and id are proven with GitHub BEFORE anything is stored, so a typo never replaces
  // a working connection. The password is asked for: this decides where webhooks are believed from and what can clone private code.
  r.post('/manual', limiter(10), async (req, res, next) => {
    try {
      const { password, appId, privateKey: pem, webhookSecret } = req.body ?? {};
      if (typeof password !== 'string') return res.status(400).json({ error: 'Give your current password' });
      const id = typeof appId === 'number' ? String(appId) : appId;
      if (id === undefined || id === null || id === '') return res.status(400).json({ error: 'Enter the app ID (a number)' });
      if (typeof id !== 'string' || !/^\d{1,20}$/.test(id.trim())) return res.status(400).json({ error: 'The app ID must be a number (the App ID on the app\'s settings page, not the Client ID)' });
      if (typeof pem !== 'string' || !pem.trim()) return res.status(400).json({ error: 'Paste the private key (the .pem file)' });
      let key;
      try { key = parsePrivateKeyPem(pem); } catch (err) { return res.status(400).json({ error: err.message }); }
      if (typeof webhookSecret !== 'string' || !webhookSecret) return res.status(400).json({ error: 'Enter the webhook secret' });
      if (webhookSecret.length < 16) return res.status(400).json({ error: 'The webhook secret must be at least 16 characters' });
      if (webhookSecret.length > 256) return res.status(400).json({ error: 'The webhook secret can be at most 256 characters' });

      const user = await checkPassword(req, res, password);
      if (!user) return undefined;

      let info;
      try {
        info = await createGithubClient({ appId: id.trim(), privateKey: key, ...(fetch ? { fetch } : {}) }).getApp();
      } catch (err) {
        if (err instanceof GithubError && [401, 403, 404].includes(err.status)) {
          return res.status(400).json({ error: 'GitHub did not accept this app ID and private key. Check that the ID is the App ID (not the Client ID) and that the key was made for this app.', code: 'github_rejected' });
        }
        if (err instanceof GithubError && err.status === undefined) {
          return res.status(502).json({ error: 'Could not reach GitHub to check the app. Try again in a moment.', code: 'github_unreachable' });
        }
        return res.status(502).json({ error: 'GitHub could not check the app right now.', code: 'github_error' });
      }
      if (String(info.id) !== id.trim()) {
        return res.status(400).json({ error: 'GitHub says this key belongs to a different app than the ID you entered.', code: 'app_id_mismatch' });
      }

      await saveGithubApp(db, secretsKey, {
        appId: id.trim(), slug: info.slug, name: info.name, ownerLogin: info.ownerLogin, htmlUrl: info.htmlUrl,
        privateKeyPem: key.export({ type: 'pkcs8', format: 'pem' }).toString(), webhookSecret, source: 'manual',
      });
      await forgetInstallations(db);
      provider.invalidate();
      await recordAttempt(db, { kind: 'github', username: user.username, address: addressOf(req), success: true });
      const { app } = await provider.status();
      res.json({ connected: Boolean(app), app });
    } catch (err) {
      next(err);
    }
  });

  // Forget the app. Deployed apps keep running; private repositories cannot be built until GitHub is connected again.
  r.delete('/', limiter(10), async (req, res, next) => {
    try {
      const { password } = req.body ?? {};
      if (typeof password !== 'string') return res.status(400).json({ error: 'Give your current password' });
      const user = await checkPassword(req, res, password);
      if (!user) return undefined;
      const removed = await deleteGithubApp(db);
      await forgetInstallations(db);
      provider.invalidate();
      if (removed) await recordAttempt(db, { kind: 'github', username: user.username, address: addressOf(req), success: true });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  const WEBHOOK_PATH = '/api/webhooks/github';
  const expectedWebhook = async () => {
    const { publicUrl } = await settings.public();
    return publicUrl ? `${publicUrl}${WEBHOOK_PATH}` : null;
  };
  const githubFailure = (res, err, doing) => {
    console.error(`${doing} failed:`, err.message);
    if (err instanceof GithubError && err.status === undefined) return res.status(502).json({ error: 'Could not reach GitHub. Try again in a moment.', code: 'github_unreachable' });
    if (err instanceof GithubError && [401, 403, 404].includes(err.status)) return res.status(502).json({ error: 'GitHub did not accept the request. Check that the app still exists and its key is the current one.', code: 'github_rejected' });
    return res.status(502).json({ error: 'GitHub could not do that right now.', code: 'github_error' });
  };

  // Does GitHub send webhooks to the address Shipdok expects (the public address + the webhook path)?
  r.get('/webhook', async (req, res, next) => {
    try {
      const github = await provider.client();
      if (!github) return res.status(501).json(NOT_CONNECTED);
      const expected = await expectedWebhook();
      try {
        const { url: actual } = await github.getWebhookConfig();
        res.json({ expected, actual, matches: expected && actual ? expected === actual : null });
      } catch (err) {
        githubFailure(res, err, 'Reading the webhook address from GitHub');
      }
    } catch (err) {
      next(err);
    }
  });

  // Point GitHub at the expected address (the retry for the automatic update that follows a change of the public address).
  r.post('/webhook/sync', limiter(20), async (req, res, next) => {
    try {
      const github = await provider.client();
      if (!github) return res.status(501).json(NOT_CONNECTED);
      const expected = await expectedWebhook();
      if (!expected) return res.status(400).json({ error: 'Set the public address first (Security > Public access)', code: 'no_public_address' });
      try {
        await github.updateWebhookUrl(expected);
        res.json({ expected, actual: expected, matches: true });
      } catch (err) {
        githubFailure(res, err, 'Updating the webhook address on GitHub');
      }
    } catch (err) {
      next(err);
    }
  });

  r.get('/repos', async (req, res, next) => {
    try {
      const github = await provider.client();
      if (!github) return res.status(501).json(NOT_CONNECTED);
      try {
        res.json({ repos: await github.listAllRepos() });
      } catch (err) {
        console.error('Listing GitHub repositories failed:', err.message);
        res.status(502).json({ error: 'Could not list repositories from GitHub' });
      }
    } catch (err) {
      next(err);
    }
  });

  // The branches of a repository, for the branch pickers: through the app's installation when it is installed there, otherwise anonymously
  // (public repositories). It works with no GitHub App connected too, for public repositories. Good answers are kept for a minute so a form
  // that is being typed into does not ask GitHub on every keystroke; failures are never kept.
  const branchCache = new Map(); // "app|owner/name" -> { at, value }
  r.get('/branches', async (req, res, next) => {
    try {
      const repo = req.query.repo;
      if (typeof repo !== 'string' || !REPO_FULL_NAME_RE.test(repo)) return res.status(400).json({ error: 'repo must be a repository like owner/name', code: 'bad_repo' });
      const github = await provider.client();
      const key = `${github ? 'app' : 'anon'}|${repo.toLowerCase()}`;
      const hit = branchCache.get(key);
      if (hit && Date.now() - hit.at < BRANCH_CACHE_MS) return res.json(hit.value);
      try {
        const value = github ? await github.listBranches(repo) : await listRepoBranches(repo, { fetch });
        if (branchCache.size >= BRANCH_CACHE_MAX) branchCache.delete(branchCache.keys().next().value);
        branchCache.set(key, { at: Date.now(), value });
        res.json(value);
      } catch (err) {
        const status = err instanceof GithubError ? err.status : undefined;
        if (status === 404) {
          return res.status(404).json({ error: 'GitHub has no such public repository, and the Shipdok GitHub App is not installed on it (a private repository needs the app).', code: 'repo_not_found' });
        }
        console.error('Listing GitHub branches failed:', err.message);
        if (status === 403 || status === 429) return res.status(502).json({ error: 'GitHub is limiting requests right now. Type the branch name, or try again in a few minutes.', code: 'rate_limited' });
        res.status(502).json({ error: 'Could not list the branches from GitHub', code: 'github_unreachable' });
      }
    } catch (err) {
      next(err);
    }
  });

  // Where the app is installed (the page's "check again" after installing it).
  r.get('/installations', async (req, res, next) => {
    try {
      const github = await provider.client();
      if (!github) return res.status(501).json(NOT_CONNECTED);
      try {
        const installations = (await github.listInstallations()).map((i) => ({ id: i.id, account: i.account }));
        res.json({ installations });
      } catch (err) {
        console.error('Listing GitHub installations failed:', err.message);
        res.status(502).json({ error: 'Could not ask GitHub where the app is installed' });
      }
    } catch (err) {
      next(err);
    }
  });

  return r;
}
