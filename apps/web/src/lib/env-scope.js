// Where a variable is available: the running container, `docker build` only, or both. The same rules as the API
// (packages/shared/src/constants.js), so a mistake is caught before a request.
export const SCOPES = [
  { value: 'runtime', label: 'Runtime', short: 'Runtime' },
  { value: 'build', label: 'Build only', short: 'Build' },
  { value: 'both', label: 'Build and runtime', short: 'Build + runtime' },
]
export const scopeLabel = (scope) => (SCOPES.find((s) => s.value === scope) ?? SCOPES[0]).short
export const reachesBuild = (scope) => scope === 'build' || scope === 'both'
// The badge beside a variable's name. Build and Both share a colour: either way the value reaches the build (and may be baked into the image).
export const scopeBadgeClass = (scope) => (reachesBuild(scope)
  ? 'border-primary/40 bg-primary/10 text-primary'
  : 'border-border bg-muted text-muted-foreground')

const BUILD_RESERVED = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'PWD', 'LANG', 'TZ'])
const BUILD_RESERVED_PREFIXES = ['LD_', 'DOCKER_', 'BUILDKIT_', 'BUILDX_', 'COMPOSE_', 'XDG_', 'LC_']

/** Why this name cannot be used at build time, or null. (Names that are reserved for every scope are the API's to refuse.) */
export function buildNameProblem(name) {
  const n = String(name ?? '').trim()
  if (BUILD_RESERVED.has(n) || BUILD_RESERVED_PREFIXES.some((p) => n.startsWith(p))) {
    return `${n} cannot be used at build time: it changes how the build runs. Use another name, or keep it runtime-only.`
  }
  return null
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** What is wrong with a variable name's shape (the API checks the rest, such as names reserved for every scope), or null. */
export const nameFormatProblem = (name) => (NAME_RE.test(String(name ?? '')) ? null : 'Use letters, digits and underscore, not starting with a digit, at most 128 characters')
