import { Loader2, Lock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Combobox, ListedOption, UseOption } from '@/components/combobox'
import { repoOptions } from '@/lib/repos'
import { parseRepoInput } from '@/lib/repo'

const PrivateBadge = () => <Badge variant="outline" className="ml-auto shrink-0 gap-1"><Lock className="size-3" aria-hidden="true" />private</Badge>
const PublicBadge = () => <Badge variant="outline" className="ml-auto shrink-0 text-muted-foreground">public</Badge>

/**
 * Choose a repository from the ones the Shipdok GitHub App can see (searchable, private or public marked), or use any owner/name, or paste a
 * GitHub link. Without a GitHub App, or if the list cannot be loaded, it is a plain text box (which also turns a pasted link into owner/name),
 * so typing the repository always works.  `repos` is the result of useRepos().
 */
export function RepoPicker({ id, value, onChange, repos }) {
  if (repos.isPending) {
    return (
      <Button id={id} type="button" variant="outline" disabled className="w-full justify-start font-normal text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />Loading repositories…
      </Button>
    )
  }
  if (!repos.data?.available) return <TextRepo id={id} value={value} onChange={onChange} /> // no GitHub App, or the list failed to load (then there is no data)
  return <RepoCombobox id={id} value={value} onChange={onChange} list={repos.data.repos} />
}

// A GitHub link pasted (several characters arriving at once) becomes owner/name straight away; one typed key at a time is left alone, so a link
// being typed is not rewritten under the person's fingers, and is turned into owner/name when the field is left.
function TextRepo({ id, value, onChange }) {
  return (
    <Input
      id={id} placeholder="owner/repo, or paste the GitHub link" autoComplete="off" spellCheck={false} value={value}
      onChange={(e) => { const text = e.target.value; onChange((text.length - value.length > 1 && parseRepoInput(text)) || text) }}
      onBlur={() => { const repo = parseRepoInput(value); if (repo && repo !== value) onChange(repo) }}
    />
  )
}

function RepoCombobox({ id, value, onChange, list }) {
  const optionsFor = (query) => {
    const { options, more } = repoOptions(list, query)
    return {
      more,
      options: options.map((o) => ({
        key: `${o.custom ? 'use' : 'r'}:${o.name}`, name: o.name, custom: o.custom, selected: !o.custom && o.name === value,
        node: o.custom ? <UseOption name={o.name} /> : <ListedOption name={o.name} selected={o.name === value} badge={o.private ? <PrivateBadge /> : <PublicBadge />} />,
      })),
    }
  }
  const current = list.find((r) => r.fullName === value)
  const footer = (more) => (
    <p className="border-t px-3 py-2 text-xs text-muted-foreground">
      {list.length === 0 ? 'The Shipdok GitHub App cannot see any repository yet: install it on one from the GitHub page. ' : `${list.length} repositor${list.length === 1 ? 'y' : 'ies'} the Shipdok GitHub App can see. `}
      {more > 0 ? `${more} more match${more === 1 ? '' : 'es'}: keep typing. ` : ''}
      Paste a GitHub link or type owner/name to use any public repository.
    </p>
  )
  return (
    <Combobox
      id={id} value={value} hasValue={Boolean(value)} placeholder="Choose a repository"
      display={<><span className="truncate">{value}</span>{current && (current.private ? <PrivateBadge /> : <PublicBadge />)}</>}
      optionsFor={optionsFor} onChoose={(o) => onChange(o.name)}
      searchLabel="Search repositories" listLabel="Repositories" searchPlaceholder="Search, or paste a GitHub link" emptyText="No repository matches." footer={footer}
    />
  )
}
