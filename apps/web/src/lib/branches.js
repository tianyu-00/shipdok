// The branch picker's rules, kept apart from the component so they are easy to test.

// The same shape the API accepts for a repository (packages/shared REPO_FULL_NAME_RE): letters, digits, dot, dash, underscore, one slash.
const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/
export const isRepoName = (repo) => typeof repo === 'string' && REPO_RE.test(repo)

export const OPTION_LIMIT = 100 // how many matches are drawn at once; narrowing the search shows the rest

/**
 * What the list shows for the text typed in the search box.
 *   - every branch that contains the text (ignoring case), the default branch marked and, as the list comes, first
 *   - when text is typed and no branch is called exactly that, one more option at the end: use that name as it is (a branch
 *     GitHub has not shown us yet, or one past the first 500)
 * @returns {{ options: {name: string, isDefault: boolean, custom: boolean}[], more: number }}  more: matches not drawn
 */
export function branchOptions(branches, query, defaultBranch = null, limit = OPTION_LIMIT) {
  const text = String(query ?? '').trim()
  const low = text.toLowerCase()
  const matches = (branches ?? []).filter((b) => !low || b.toLowerCase().includes(low))
  const drawn = matches.slice(0, limit).map((name) => ({ name, isDefault: name === defaultBranch, custom: false }))
  const exact = (branches ?? []).includes(text)
  if (text && !exact) drawn.push({ name: text, isDefault: false, custom: true })
  return { options: drawn, more: Math.max(0, matches.length - limit) }
}

/** Moves the highlighted option by `delta`, wrapping round at either end. -1 when there is nothing to highlight. */
export function stepActive(active, delta, count) {
  if (count <= 0) return -1
  if (active < 0) return delta > 0 ? 0 : count - 1
  return (active + delta + count) % count
}

/** Where the highlight starts when the list opens: on the current branch if it is listed, otherwise on the first option. */
export function startActive(options, value) {
  if (!options.length) return -1
  const at = options.findIndex((o) => !o.custom && o.name === value)
  return at >= 0 ? at : 0
}
