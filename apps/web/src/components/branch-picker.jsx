import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Combobox, ListedOption, UseOption } from '@/components/combobox'
import { branchOptions, isRepoName } from '@/lib/branches'
import { useBranches } from '@/lib/queries'
import { useDebounced } from '@/lib/use-debounced'

/**
 * Choose a branch from the repository's real ones, with a search box, the default branch marked, and a way to use a name that is not in the
 * list. If the branches cannot be listed (GitHub not reachable, a private repository the app is not installed on, a name that is not a
 * repository) it is a plain text box, so typing the name always works.
 *
 * `onDefaultKnown(branch)` is called once the repository's default branch is known, so a form can start with it.
 */
export function BranchPicker({ id, repo, value, onChange, onDefaultKnown, invalid, githubAppId }) {
  const wanted = useDebounced(String(repo ?? '').trim(), 400) // not on every key while the repository is being typed
  const branches = useBranches(wanted, githubAppId)
  const data = branches.data
  const known = isRepoName(wanted)

  const defaultBranch = data?.defaultBranch ?? null
  useEffect(() => { if (defaultBranch) onDefaultKnown?.(defaultBranch) }, [defaultBranch, wanted]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!known) return <Input id={id} aria-invalid={invalid} autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />

  if (branches.isPending || branches.isFetching && !data) {
    return (
      <Button id={id} type="button" variant="outline" disabled className="w-full justify-start font-normal text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />Loading branches…
      </Button>
    )
  }

  if (branches.isError) {
    return (
      <div className="space-y-1.5">
        <Input id={id} aria-invalid={invalid} autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />
        <p role="status" className="text-xs text-muted-foreground">
          {branches.error?.body?.error ?? 'Could not load the branches.'} Type the branch name.
        </p>
      </div>
    )
  }

  const listed = data.branches.includes(value)
  return (
    <div className="space-y-1.5">
      <BranchCombobox id={id} value={value} data={data} onChange={onChange} invalid={invalid} />
      {value && !listed && !data.truncated && (
        <p role="status" className="text-xs text-warning">“{value}” is not among this repository's branches. It may be new, or the name may be wrong.</p>
      )}
    </div>
  )
}

function BranchCombobox({ id, value, data, onChange, invalid }) {
  const optionsFor = (query) => {
    const { options, more } = branchOptions(data.branches, query, data.defaultBranch)
    return {
      more,
      options: options.map((o) => ({
        key: `${o.custom ? 'use' : 'b'}:${o.name}`, name: o.name, custom: o.custom, selected: !o.custom && o.name === value,
        node: o.custom ? <UseOption name={o.name} /> : <ListedOption name={o.name} selected={o.name === value} badge={o.isDefault && <Badge variant="outline" className="ml-auto shrink-0">default</Badge>} />,
      })),
    }
  }
  const footer = (more) => (more > 0 || data.truncated) && (
    <p className="border-t px-3 py-2 text-xs text-muted-foreground">
      {more > 0 ? `${more} more match${more === 1 ? '' : 'es'}: keep typing to narrow the list. ` : ''}
      {data.truncated ? 'Only the first 500 branches are listed; type a name to use any other.' : ''}
    </p>
  )
  return (
    <Combobox
      id={id} invalid={invalid} value={value} hasValue={Boolean(value)} display={<span className="truncate">{value}</span>} placeholder="Choose a branch"
      optionsFor={optionsFor} onChoose={(o) => onChange(o.name)}
      searchLabel="Search branches" listLabel="Branches" searchPlaceholder="Search or type a branch" emptyText="This repository has no branches yet." footer={footer}
    />
  )
}
