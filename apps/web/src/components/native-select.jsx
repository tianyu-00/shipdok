import { ChevronDown } from 'lucide-react'

// A plain <select> (accessible, and good on a phone) drawn like the inputs, with its own arrow instead of the browser's.
export function NativeSelect({ id, value, onChange, disabled, label, children }) {
  return (
    <div className="relative">
      <select
        id={id} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full appearance-none rounded-md border border-input bg-transparent pl-3 pr-9 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
    </div>
  )
}
