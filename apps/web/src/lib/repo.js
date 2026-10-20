// A repository as people copy it: the address bar of github.com, a clone address, or plain owner/name. Shipdok stores owner/name (the API
// only accepts that, and builds the clone address itself), so a pasted link is turned into it here.

const NAME_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/ // the same shape the API accepts

// github.com only (with or without www), after an optional scheme and optional user@ (which also covers git@github.com:owner/name). Not "github.com.evil.example", not another host that merely mentions it.
const WEB_OR_SSH_URL = /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com[/:](.+)$/i

/**
 * "https://github.com/owner/name", "github.com/owner/name/", "https://github.com/owner/name.git", ".../tree/main/src?x=1#y",
 * "git@github.com:owner/name.git", "ssh://git@github.com/owner/name.git"  ->  "owner/name".
 * Anything else (plain owner/name included, other hosts, junk) -> null: the caller keeps what was typed.
 */
export function parseRepoInput(text) {
  const raw = String(text ?? '').trim()
  const m = WEB_OR_SSH_URL.exec(raw)
  if (!m) return null
  const [owner, name] = m[1].split(/[?#]/)[0].split('/')
  if (!owner || !name) return null
  const repo = `${owner}/${name.replace(/\.git$/i, '')}`
  return NAME_RE.test(repo) ? repo : null
}
