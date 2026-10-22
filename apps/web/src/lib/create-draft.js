// What has been chosen so far when creating an app (the GitHub app and the repository), kept in this browser tab only. Connecting a GitHub app
// takes the person to GitHub and back, which would otherwise lose the repository they had just chosen. Nothing secret is kept; it expires after an hour.

const KEY = 'shipdok.create-app'
const MAX_AGE_MS = 60 * 60 * 1000

/** githubApp: undefined = not chosen yet, '' = none, otherwise an app's id. */
export function saveDraft({ repo, githubApp }, now = Date.now()) {
  try {
    if (!repo) { sessionStorage.removeItem(KEY); return }
    sessionStorage.setItem(KEY, JSON.stringify({ repo, githubApp: githubApp === undefined ? null : githubApp, at: now }))
  } catch { /* storage can be blocked or full: the page works without it */ }
}

/** { repo, githubApp } or null. */
export function loadDraft(now = Date.now()) {
  try {
    const d = JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
    if (!d || typeof d.repo !== 'string' || d.repo.length > 200 || typeof d.at !== 'number' || now - d.at > MAX_AGE_MS || now < d.at) return null
    if (d.githubApp !== null && typeof d.githubApp !== 'string') return null
    return { repo: d.repo, githubApp: d.githubApp === null ? undefined : d.githubApp }
  } catch { return null }
}

export function clearDraft() {
  try { sessionStorage.removeItem(KEY) } catch { /* nothing to clear */ }
}
