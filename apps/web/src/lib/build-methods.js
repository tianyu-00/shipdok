// The ways an app can be built, as the cards of the second step of creating one. A method that is not built yet is shown as "coming soon".
// Shipdok does not look inside the repository to guess which one fits: the person chooses, and Railpack (which needs nothing from the repository) is the default.

export const DEFAULT_METHOD = 'railpack'

export const METHOD_CARDS = [
  { id: 'dockerfile', title: 'Dockerfile', available: true, text: 'Builds the Dockerfile in your repository, so you decide exactly how the image is made.' },
  { id: 'railpack', title: 'Railpack', available: true, text: 'No Dockerfile needed. It looks at your code (Node, Python, Go, PHP, Ruby, Java, Rust and more), works out how to build it, and builds that.' },
  { id: 'static', title: 'Static site', available: true, text: 'Serves HTML, CSS and JavaScript files with a small web server (nginx or Caddy). It can run your build command first, for example for a Vite or React site.' },
]

export const cardFor = (id) => METHOD_CARDS.find((c) => c.id === id) ?? null

// What choosing "Static site" fills in (a static site needs little memory, listens on its own port, and most are built with npm). Only what is still at its
// starting value is replaced, and leaving the method puts back only what it filled in, so nothing the person typed is lost.
const STATIC_FILLS = { container_port: ['3000', '8080'], memory_mb: ['512', '128'] }
const STATIC_COMMAND_FILLS = { install_command: 'npm ci', build_command: 'npm run build' }

/** The changes to the form's values when the method changes from `f.build_method` to `id`. */
export function methodChanges(f, id) {
  const patch = { build_method: id }
  if (id === 'static' && f.build_method !== 'static') {
    for (const [key, [from, to]] of Object.entries(STATIC_FILLS)) if (f[key] === from) patch[key] = to
    if (!f.install_command.trim() && !f.build_command.trim()) Object.assign(patch, STATIC_COMMAND_FILLS)
    if (!f.output_dir.trim()) patch.output_dir = 'dist'
  } else if (id !== 'static' && f.build_method === 'static') {
    for (const [key, [from, to]] of Object.entries(STATIC_FILLS)) if (f[key] === to) patch[key] = from
    if (f.install_command === STATIC_COMMAND_FILLS.install_command && f.build_command === STATIC_COMMAND_FILLS.build_command) Object.assign(patch, { install_command: '', build_command: '' })
    if (f.output_dir === 'dist') patch.output_dir = ''
  }
  return patch
}
