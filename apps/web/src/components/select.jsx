import { Children, isValidElement } from 'react'
import { Check } from 'lucide-react'
import { Combobox } from '@/components/combobox'
import { cn } from '@/lib/utils'

const optionsOf = (children) => Children.toArray(children)
  .filter((c) => isValidElement(c) && c.type === 'option')
  .map((c) => ({ value: String(c.props.value ?? ''), label: Children.toArray(c.props.children).join(''), disabled: Boolean(c.props.disabled) }))

/**
 * A choice of one of a few things, in the same popover as the repository and branch lists but without the search box.
 * Written like a <select>: its children are <option value>text</option>; `onChange` gets the chosen value as text. An option marked `disabled`
 * is only a placeholder: shown while it is the value, never offered.
 */
export function Select({ id, value, onChange, disabled, label, children }) {
  const all = optionsOf(children)
  const current = all.find((o) => o.value === String(value))
  const listed = all.filter((o) => !o.disabled)
  return (
    <Combobox
      id={id} searchable={false} mono={false} disabled={disabled} value={String(value)} width="min-w-0"
      triggerProps={{ 'aria-label': label, 'data-value': String(value) }}
      hasValue={Boolean(current) && !current.disabled} display={<span className="truncate">{current?.label}</span>} placeholder={current?.label ?? 'Choose'}
      optionsFor={() => ({
        options: listed.map((o) => ({
          key: o.value, value: o.value, name: o.value, selected: o.value === String(value),
          node: (
            <>
              <Check className={cn('size-4 shrink-0', o.value === String(value) ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
              <span className="truncate">{o.label}</span>
            </>
          ),
        })),
      })}
      onChoose={(o) => onChange(o.value)}
      listLabel={label}
    />
  )
}
