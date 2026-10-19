import { Label } from '@/components/ui/label'

/** A labelled input with an optional hint underneath and, when something is wrong, the reason in red (linked for screen readers). */
export function Field({ id, label, hint, error, children }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{error}</p>}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
