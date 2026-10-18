import { Router } from 'express';

// Lists repositories the GitHub App can see, for a repository picker in the dashboard.
// Never exposes tokens: only names and visibility.
export function githubRouter({ github }) {
  const r = Router();
  r.get('/repos', async (req, res, next) => {
    if (!github) return res.status(501).json({ error: 'GitHub App is not configured' });
    try {
      const repos = await github.listAllRepos();
      res.json({ repos });
    } catch (err) {
      console.error('Listing GitHub repositories failed:', err.message);
      res.status(502).json({ error: 'Could not list repositories from GitHub' });
    }
  });
  return r;
}
