// "Dismiss" on the update notice remembers the version that was dismissed, in this browser only. A newer release shows the notice again.
const KEY = 'shipdok-dismissed-update'

export function dismissedUpdate() {
  try { return localStorage.getItem(KEY) } catch { return null }
}

export function dismissUpdate(version) {
  try { localStorage.setItem(KEY, version) } catch { /* private window: the notice comes back next time, which is harmless */ }
}
