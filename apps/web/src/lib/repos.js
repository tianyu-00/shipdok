// The repository picker's rules, kept apart from the component so they are easy to test.
import { OPTION_LIMIT, isRepoName } from '@/lib/branches'
import { parseRepoInput } from '@/lib/repo'

/**
 * What the list shows for the text typed in the search box.
 *   - the repositories the GitHub App can see whose name contains the text (ignoring case), alphabetical, each marked private or public
 *   - a pasted GitHub link means the repository it points at, so a link finds (and offers) that repository
 *   - when the text is a usable owner/name and no listed repository is called that (GitHub ignores case), one more option at the end: use it as
 *     typed, which is how a public repository the app is not installed on is chosen
 * @returns {{ options: {name: string, private: boolean, custom: boolean}[], more: number }}  more: matches not drawn
 */
export function repoOptions(repos, query, limit = OPTION_LIMIT) {
  const typed = String(query ?? '').trim()
  const text = parseRepoInput(typed) ?? typed
  const low = text.toLowerCase()
  const sorted = [...(repos ?? [])].sort((a, b) => a.fullName.localeCompare(b.fullName))
  const matches = sorted.filter((r) => !low || r.fullName.toLowerCase().includes(low))
  const drawn = matches.slice(0, limit).map((r) => ({ name: r.fullName, private: Boolean(r.private), custom: false }))
  const listed = sorted.some((r) => r.fullName.toLowerCase() === low)
  if (isRepoName(text) && !listed) drawn.push({ name: text, private: false, custom: true })
  return { options: drawn, more: Math.max(0, matches.length - limit) }
}
