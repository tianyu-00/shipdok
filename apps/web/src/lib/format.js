// Small, pure helpers for showing values. Kept apart from the components so they are easy to test.

export function timeAgo(value, now = Date.now()) {
  if (!value) return '—'
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return '—'
  const s = Math.round((now - then) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

export function formatDuration(start, end) {
  if (!start || !end) return '—'
  const s = Math.max(0, Math.round((new Date(end) - new Date(start)) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function formatBytes(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—'
  const v = Number(n)
  if (v < 1024) return `${v} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let x = v / 1024
  let i = 0
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1 }
  return `${x >= 100 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}`
}

export const shortSha = (sha) => (sha ? sha.slice(0, 7) : '—')

// Deployment statuses (what happened to one deployment) ...
export const DEPLOYMENT_STATUS = {
  queued: { label: 'Queued', tone: 'muted', active: true },
  building: { label: 'Building', tone: 'info', active: true },
  starting: { label: 'Starting', tone: 'info', active: true },
  validating: { label: 'Validating', tone: 'info', active: true },
  successful: { label: 'Successful', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  superseded: { label: 'Superseded', tone: 'muted' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
}

// ... and runtime states (what the running container is doing). They are separate things, as the spec requires.
export const RUNTIME_STATE = {
  running: { label: 'Running', tone: 'success' },
  stopped: { label: 'Stopped', tone: 'muted' },
  unhealthy: { label: 'Unhealthy', tone: 'warning' },
  restarting: { label: 'Restarting', tone: 'info' },
  crashed: { label: 'Crashed', tone: 'danger' },
}

// The administrator's wish and the worker's report can differ for a moment (a Stop was pressed, the container is still going down).
// Showing that gap is more honest than showing the old state as if nothing had been asked.
export const TRANSITION_STATE = {
  stopping: { label: 'Stopping…', tone: 'info' },
  starting: { label: 'Starting…', tone: 'info' },
}

/** The state to show for an app: its runtime state, unless what the administrator asked for has not happened yet. */
export function displayState(app) {
  const state = app.runtime?.state
  if (app.desired_state === 'stopped' && (state === 'running' || state === 'unhealthy' || state === 'restarting')) return 'stopping'
  if (app.desired_state === 'running' && state === 'stopped') return 'starting'
  return state
}

export const isActiveDeployment = (status) => DEPLOYMENT_STATUS[status]?.active === true

/** One short sentence for why a deployment ended the way it did (or null when there is nothing to explain). */
export function deploymentReason(d) {
  if (d.error_summary) return d.error_summary
  if (d.status === 'cancelled') return 'Cancelled'
  if (d.status === 'superseded') return 'Replaced by a newer deployment'
  return null
}

/** A log line is "<ISO time> <stdout|stderr|shipdok> <message>". Anything else is shown as it is. */
export function parseLogLine(line) {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (stdout|stderr|shipdok) ?(.*)$/.exec(line)
  if (!m) return { time: null, stream: 'stdout', message: line }
  return { time: m[1], stream: m[2], message: m[3] }
}

// Where an app answers on the network, as seen from the machine the dashboard is open on.
// The port the RUNNING version answers on: an edited host port only takes effect with the next deployment.
export const appAddress = (app, host = window.location.hostname) => `http://${host}:${app.running_settings?.host_port ?? app.host_port}`

// The repository's page on GitHub. `repo` is validated as owner/repo by the API; anything else gets no link.
export const repoUrl = (repo) => (/^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/.test(repo ?? '') ? `https://github.com/${repo}` : null)
