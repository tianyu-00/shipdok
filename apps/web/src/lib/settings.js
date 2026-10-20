// The settings of an app that can be edited later, and the checks the server also makes (so a typo is caught before a request).

export const SETTING_LABELS = {
  name: 'Name', branch: 'Branch', root_dir: 'Root directory', container_port: 'Container port', host_port: 'Host port',
  health_path: 'Health check path', memory_mb: 'Memory limit', cpus: 'CPU limit', max_restarts: 'Automatic restarts',
  build_timeout_minutes: 'Build time limit', volumes: 'Persistent storage',
}

/** The form's text values for an app. */
export const settingsToForm = (app) => ({
  name: app.name, branch: app.branch, root_dir: app.root_dir, container_port: String(app.container_port), host_port: String(app.host_port),
  health_path: app.health_path ?? '', memory_mb: String(app.memory_mb), cpus: String(Number(app.cpus)), max_restarts: String(app.max_restarts),
  build_timeout_minutes: app.build_timeout_minutes == null ? '' : String(app.build_timeout_minutes), // empty = no limit
})

const whole = (v) => /^\d+$/.test(v.trim()) ? Number(v) : null
const decimal = (v) => /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null

/** Field -> message, for everything wrong in the form. Empty object means it can be sent. */
export function settingsProblems(f) {
  const p = {}
  if (!f.name.trim()) p.name = 'Give the app a name'
  else if (!/[A-Za-z0-9]/.test(f.name)) p.name = 'The name must contain letters or numbers'
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/.test(f.branch.trim())) p.branch = 'That is not a valid branch name'
  const root = f.root_dir.trim()
  if (!root || !/^[A-Za-z0-9._/-]+$/.test(root) || root.startsWith('/') || root.split('/').includes('..')) p.root_dir = 'Use a relative folder inside the repository, for example . or web'
  const cp = whole(f.container_port)
  if (cp === null || cp < 1 || cp > 65535) p.container_port = 'A whole number from 1 to 65535'
  const hp = whole(f.host_port)
  if (hp === null || hp < 1024 || hp > 65535) p.host_port = 'A whole number from 1024 to 65535'
  if (f.health_path.trim() && !/^\/[^\s]*$/.test(f.health_path.trim())) p.health_path = 'Start with / and use no spaces, for example /health'
  const mem = whole(f.memory_mb)
  if (mem === null || mem < 64 || mem > 8192) p.memory_mb = 'A whole number from 64 to 8192'
  const cpu = decimal(f.cpus)
  if (cpu === null || cpu < 0.1 || cpu > 4) p.cpus = 'A number from 0.1 to 4'
  const mr = whole(f.max_restarts)
  if (mr === null || mr > 50) p.max_restarts = 'A whole number from 0 to 50'
  const bt = f.build_timeout_minutes.trim()
  if (bt !== '') { const n = whole(bt); if (n === null || n < 5 || n > 10080) p.build_timeout_minutes = 'Empty for no limit, or a whole number of minutes from 5 to 10080' }
  return p
}

/** Only what differs from the app as it is now, in the shape the API takes. Empty object: nothing to save. */
export function settingsChanges(f, app) {
  const was = settingsToForm(app)
  const out = {}
  const text = { name: f.name.trim(), branch: f.branch.trim(), root_dir: f.root_dir.trim() }
  for (const k of ['name', 'branch', 'root_dir']) if (text[k] !== was[k]) out[k] = text[k]
  for (const k of ['container_port', 'host_port', 'memory_mb', 'max_restarts']) if (Number(f[k]) !== Number(was[k])) out[k] = Number(f[k])
  if (Number(f.cpus) !== Number(was.cpus)) out.cpus = Number(f.cpus)
  if (f.build_timeout_minutes.trim() !== was.build_timeout_minutes) out.build_timeout_minutes = f.build_timeout_minutes.trim() === '' ? null : Number(f.build_timeout_minutes)
  if (f.health_path.trim() !== was.health_path) out.health_path = f.health_path.trim() === '' ? null : f.health_path.trim()
  return out
}

/** The settings the running version has (falls back to the app's own when nothing has been deployed yet). */
export const runningSetting = (app, key) => (app.running_settings && key in app.running_settings ? app.running_settings[key] : app[key])
