// Works out how git should authenticate for a deployment: anonymously (public repositories), or with a
// short-lived token scoped to this one repository.
import { gitAuthEnv, REPO_FULL_NAME_RE } from '@shipdok/shared';

// The message is safe to store and show: it never contains a token, a key, or a response body.
export class GitAuthError extends Error {}

/**
 * @param {object} p
 * @param {object|null} p.github       client from createGithubClient, or null when the GitHub App is not configured
 * @param {object} p.db                needs setInstallationId(appId, installationId)
 * @param {number|string} [p.installationId]  the app's stored installation, if any
 * @param {string} p.appId
 * @param {string} p.repoFullName      owner/repo
 * @param {(msg: string) => void} [p.log]
 * @returns {Promise<{ gitEnv?: Record<string, string> }>} empty for an anonymous clone
 */
export async function resolveGitAuth({ github, db, installationId, appId, repoFullName, log = () => {} }) {
  if (!github) {
    // Without the app we can only clone public repositories, which needs no auth at all.
    if (installationId) throw new GitAuthError('This app uses the GitHub App, but it is not configured on the worker');
    return {};
  }
  if (typeof repoFullName !== 'string' || !REPO_FULL_NAME_RE.test(repoFullName)) {
    throw new GitAuthError('Invalid repository name');
  }

  const stored = Boolean(installationId);
  let id = stored ? Number(installationId) : null;
  if (!id) {
    // The app might have been installed after this Shipdok app was created: look it up now.
    try {
      id = await github.findInstallationForRepo(repoFullName);
    } catch {
      log('Could not check whether the GitHub App is installed on this repository; trying an anonymous clone');
      return {};
    }
    if (!id) return {}; // not installed: a public repository clones anonymously
    await Promise.resolve(db.setInstallationId(appId, id)).catch(() => {}); // remember it; a failed write must not fail the deploy
  }

  // Least privilege: a token that can read ONLY this repository's contents, and only for about an hour.
  const tokenFor = (installation) => github.getInstallationToken(installation, { repo: repoFullName, permissions: { contents: 'read' } });
  const failure = (err) => new GitAuthError(`Could not get a GitHub access token${err?.status ? ` (HTTP ${err.status})` : ''}`);

  try {
    return { gitEnv: gitAuthEnv(await tokenFor(id)) };
  } catch (err) {
    // GitHub does not know the installation we remembered. That happens when a DIFFERENT GitHub App was connected since (installation
    // ids belong to one app) or when the app was uninstalled. Look the repository up again, once, instead of failing every deploy.
    if (!(stored && err?.status === 404)) throw failure(err);
    log('The remembered GitHub installation is not valid for the connected app: looking it up again');
    let fresh;
    try {
      fresh = await github.findInstallationForRepo(repoFullName);
    } catch {
      throw failure(err);
    }
    if (!fresh) {
      log('The GitHub App is not installed on this repository (install it on GitHub for private repositories); trying an anonymous clone');
      await Promise.resolve(db.setInstallationId(appId, null)).catch(() => {});
      return {};
    }
    await Promise.resolve(db.setInstallationId(appId, fresh)).catch(() => {});
    try {
      return { gitEnv: gitAuthEnv(await tokenFor(fresh)) };
    } catch (second) {
      throw failure(second);
    }
  }
}
