// Persistent storage paths: the same rules the API applies (apps/api/src/volumepaths.js), so a mistake is caught before a request.
export const MAX_VOLUMES = 10
const SAFE = /^[A-Za-z0-9._/-]+$/
const FORBIDDEN = ['/proc', '/sys', '/dev'] // mounting over these would break the container

/** One path, tidied (doubled and trailing slashes removed): { path } or { error }. */
export function normalizeVolumePath(input) {
  const raw = String(input ?? '').trim()
  if (!raw.startsWith('/')) return { error: `"${raw}" is not an absolute path (it must start with /)` }
  const path = `/${raw.split('/').filter(Boolean).join('/')}`
  if (path === '/') return { error: 'The root directory cannot be a persistent path' }
  if (path.length > 200) return { error: 'A path can be at most 200 characters' }
  if (!SAFE.test(path)) return { error: `"${path}": use only letters, digits, dot, dash, underscore and slash` }
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return { error: `"${path}" must not contain . or .. parts` }
  if (FORBIDDEN.some((f) => path === f || path.startsWith(`${f}/`))) return { error: `${path} cannot be used: mounting over it would break the container` }
  return { path }
}

/** What is wrong with a whole list of (already tidied) paths, or null. */
export function volumePathsProblem(paths) {
  if (paths.length > MAX_VOLUMES) return `An app can have at most ${MAX_VOLUMES} persistent paths`
  const seen = []
  for (const p of paths) {
    const one = normalizeVolumePath(p)
    if (one.error) return one.error
    if (seen.includes(one.path)) return `${one.path} is listed twice`
    seen.push(one.path)
  }
  for (const a of seen) for (const b of seen) if (a !== b && b.startsWith(`${a}/`)) return `${b} is inside ${a}: keep one or the other`
  return null
}

// Folders where an image usually keeps the app's CODE. A volume mounted exactly there hides every later deployment's code behind the copy of the
// old code that Docker saved into the volume the first time, so new pushes would keep running old code. Only a warning: some images do use them for data.
const CODE_FOLDERS = ['/app', '/usr/src/app', '/home/node/app', '/code', '/workspace', '/srv', '/var/www/html', '/usr/share/nginx/html']

/** A warning for a path that is probably the app's code folder, or null. */
export function codeFolderWarning(input) {
  const { path } = normalizeVolumePath(input)
  if (!path || !CODE_FOLDERS.includes(path)) return null
  return `${path} is probably the folder your app's code lives in. A volume there hides the code of every new deployment behind the old code saved into it the first time, so new pushes would keep running old code. Use a data folder instead, such as ${path === '/app' ? '/app/data' : '/data'}.`
}
