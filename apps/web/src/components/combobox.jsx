import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronsUpDown, CornerDownLeft, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { startActive, stepActive } from '@/lib/branches'
import { cn } from '@/lib/utils'

/** The last option of a search: "Use “text”", for a name that is not in the list. */
export function UseOption({ name }) {
  return (
    <>
      <CornerDownLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate">Use “<span className="font-mono">{name}</span>”</span>
    </>
  )
}

/** A listed option: a check when it is the current one, the name, and an optional badge on the right. */
export function ListedOption({ name, selected, badge }) {
  return (
    <>
      <Check className={cn('size-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
      <span className="truncate font-mono">{name}</span>
      {badge}
    </>
  )
}

/**
 * A searchable list in a popover, used for repositories and branches. The parent decides what the options are for the text typed in the search box:
 *   optionsFor(query) -> { options: [{ key, name, custom, selected, node }], more }
 * (`custom` marks the "Use “text”" option, `more` is how many matches were left out). Arrow keys move the highlight (wrapping), Enter chooses,
 * Escape closes; typing puts the highlight on the first match.
 */
export function Combobox({ id, hasValue, display, placeholder = 'Choose', optionsFor, onChoose, value, searchLabel, listLabel, searchPlaceholder, emptyText, footer, invalid }) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const list = useRef(null)

  const { options, more } = optionsFor(query)

  const openChanged = (next) => {
    setOpen(next)
    if (next) { setQuery(''); setActive(startActive(optionsFor('').options, value)) } // starts on the current one, with an empty search
  }
  const choose = (option) => { if (!option) return; onChoose(option); setOpen(false) }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => stepActive(a, 1, options.length)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => stepActive(a, -1, options.length)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(options[active] ?? options[0]) }
  }
  const typed = (text) => { setQuery(text); setActive(optionsFor(text).options.length ? 0 : -1) }

  // Stepping with the arrows scrolls the highlighted option into view.
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [active, open])

  return (
    <Popover open={open} onOpenChange={openChanged}>
      <PopoverTrigger asChild>
        <Button
          id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? listId : undefined} aria-invalid={invalid}
          className="w-full justify-between font-mono font-normal"
        >
          {hasValue ? <span className="flex min-w-0 items-center gap-2">{display}</span> : <span className="truncate font-sans text-muted-foreground">{placeholder}</span>}
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-64">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            autoFocus type="text" value={query} onChange={(e) => typed(e.target.value)} onKeyDown={onKeyDown} placeholder={searchPlaceholder}
            aria-label={searchLabel} aria-controls={listId} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined} autoComplete="off" spellCheck={false}
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <ul ref={list} id={listId} role="listbox" aria-label={listLabel} className="max-h-60 overflow-auto p-1">
          {options.length === 0 && <li className="px-2 py-3 text-center text-sm text-muted-foreground">{emptyText}</li>}
          {options.map((o, i) => (
            <li
              key={o.key} id={`${listId}-${i}`} role="option" aria-selected={Boolean(o.selected)} data-active={i === active}
              onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(i)} onClick={() => choose(o)}
              className={cn('flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm', i === active && 'bg-accent text-accent-foreground')}
            >
              {o.node}
            </li>
          ))}
        </ul>
        {footer?.(more)}
      </PopoverContent>
    </Popover>
  )
}
