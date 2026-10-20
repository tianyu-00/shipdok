// Helpers for the list of connected GitHub Apps (GET /api/github -> `apps`).

/** How an app is named in a list: its name, and the account that owns it (several apps often share a name style such as Shipdok-ab12). */
export const appLabel = (app) => {
  const name = app.name ?? app.slug ?? `App ${app.appId}`
  return app.ownerLogin ? `${name} (${app.ownerLogin})` : name
}

/**
 * The GitHub app a new project starts with: the only one when exactly one is connected (nothing to choose), otherwise nothing yet (undefined),
 * so the person says which one the repository is on. `chosen`: undefined = not chosen yet, '' = none, otherwise an app's id.
 */
export const startingApp = (apps) => (apps.length === 1 ? apps[0].id : undefined)

/** What the form sends for `github_app_id`: nothing when no GitHub app is connected at all, null for "none", else the id. */
export const githubAppBody = (apps, chosen) => (apps.length === 0 ? {} : { github_app_id: chosen || null })
