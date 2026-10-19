import { repoUrl } from '@/lib/format'

/** The repository name as a link to its GitHub page (opens in a new tab). */
export function RepoLink({ repo }) {
  const href = repoUrl(repo)
  if (!href) return <span>{repo}</span>
  return <a href={href} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">{repo}</a>
}
