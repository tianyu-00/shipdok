// How an app's image is made: its own Dockerfile, or Railpack (no Dockerfile needed; it works out how to build the code).

export const BUILD_METHOD_NAMES = { dockerfile: 'Dockerfile', railpack: 'Railpack (no Dockerfile needed)' }

/** The root directory means the same folder either way; only what is looked for in it differs. */
export const rootDirHint = (method) => (method === 'railpack' ? 'The folder of the app inside the repository.' : 'Where the Dockerfile is, inside the repository.')

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
