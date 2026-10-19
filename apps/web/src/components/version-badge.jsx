import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { VERSION_STATE } from '@/lib/versions'

const TONE = {
  success: 'border-success/40 bg-success/10 text-success',
  info: 'border-info/40 bg-info/10 text-info',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  muted: 'border-border bg-muted text-muted-foreground',
}

/** Which of a successful deployment's saved images is the running one, a kept one, an old one, or gone. */
export function VersionBadge({ state }) {
  const s = VERSION_STATE[state]
  if (!s) return null
  return <Badge variant="outline" className={cn('font-medium', TONE[s.tone])} data-version={state}>{s.label}</Badge>
}
