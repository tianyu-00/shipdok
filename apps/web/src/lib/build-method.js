// How an app's image is made: its own Dockerfile, Railpack (no Dockerfile needed; it works out how to build the code), or a static site (files served by a small web server).

export const BUILD_METHOD_NAMES = { dockerfile: 'Dockerfile', railpack: 'Railpack (no Dockerfile needed)', static: 'Static site' }
export const STATIC_SERVER_NAMES = { nginx: 'nginx (not run as root)', caddy: 'Caddy' }

/** The root directory means the same folder either way; only what is looked for in it differs. */
export const rootDirHint = (method) => (method === 'dockerfile' ? 'Where the Dockerfile is, inside the repository.' : method === 'static' ? 'The folder of the site inside the repository.' : 'The folder of the app inside the repository.')

export const COMMANDS = [
  { key: 'install_command', label: 'Install command', placeholder: 'npm ci', hint: 'Installs the dependencies. A command here replaces Railpack\'s own install step completely. Leave empty to let Railpack decide.' },
  { key: 'build_command', label: 'Build command', placeholder: 'npm run build', hint: 'Builds the app, for example a front end. Leave empty to let Railpack decide.' },
  { key: 'start_command', label: 'Start command', placeholder: 'node dist/server.js', hint: 'Starts the app. It is given PORT (the container port) to listen on. Leave empty to let Railpack decide.' },
]

/** A message for a command that cannot be used, otherwise undefined. Empty is fine: Railpack decides. */
export function commandProblem(value) {
  const v = (value ?? '').trim()
  if (v.length > 1000) return 'At most 1000 characters'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return 'Use one line, without special characters'
  return undefined
}

// A static site: the install and build steps are optional (with neither, the output folder is served as it is).
export const STATIC_COMMANDS = [
  { key: 'install_command', label: 'Install command', placeholder: 'npm ci', hint: 'Installs the dependencies before the build. Leave empty to skip.' },
  { key: 'build_command', label: 'Build command', placeholder: 'npm run build', hint: 'Builds the site. Leave both commands empty to serve the folder as it is (plain HTML).' },
]

/** A message for an output folder that cannot be used, otherwise undefined. Empty is fine: the app's folder itself. */
export function outputDirProblem(value) {
  const v = (value ?? '').trim()
  if (v === '') return undefined
  if (!/^[A-Za-z0-9._/-]+$/.test(v) || v.startsWith('/') || v.split('/').includes('..') || v.length > 200) return 'Use a relative folder inside the app, for example dist or build/web'
  return undefined
}

/** A message for a Node version that cannot be used, otherwise undefined. Empty is fine: Shipdok's default. */
export function nodeVersionProblem(value) {
  const v = (value ?? '').trim()
  if (v === '') return undefined
  return /^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$/.test(v) ? undefined : 'A number such as 22, 20.11 or 18.20.4'
}
