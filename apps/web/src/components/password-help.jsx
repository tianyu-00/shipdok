import { strength } from '@/lib/password'

const BAR = ['bg-destructive', 'bg-warning', 'bg-primary', 'bg-success']

/** Under a "new password" field: what makes a good one, and how the typed one measures up. */
export function PasswordHelp({ value }) {
  const s = strength(value)
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      {s ? (
        <div className="flex items-center gap-2">
          <div role="img" aria-label={`Strength: ${s.label}`} className="flex flex-1 gap-1">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} data-filled={i <= s.level} className={`h-1.5 flex-1 rounded-full ${i <= s.level ? BAR[s.level] : 'bg-muted'}`} />
            ))}
          </div>
          <span className="w-20 text-right font-medium text-foreground">{s.label}</span>
        </div>
      ) : (
        <p>Anyone who gets in can run programs on this machine, so use a long, unique password: at least 12 characters, and the longer the better.</p>
      )}
      <p>Several random words beat clever symbols. Simple patterns are refused.</p>
    </div>
  )
}
