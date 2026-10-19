import { AlertTriangle, Ban, CheckCircle2, Clock, Hammer, Loader2, OctagonX, PauseCircle, RefreshCw, SkipForward, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { DEPLOYMENT_STATUS, RUNTIME_STATE, TRANSITION_STATE } from '@/lib/format'

// Colour is never the only signal: every state also has an icon and a word.
const TONE = {
  success: 'border-success/40 bg-success/10 text-success',
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  info: 'border-info/40 bg-info/10 text-info',
  muted: 'border-border bg-muted text-muted-foreground',
}

const DEPLOYMENT_ICON = {
  queued: Clock, building: Hammer, starting: Loader2, validating: Loader2, successful: CheckCircle2,
  failed: XCircle, cancelled: Ban, superseded: SkipForward, interrupted: AlertTriangle,
}
const RUNTIME_ICON = { running: CheckCircle2, stopped: PauseCircle, unhealthy: AlertTriangle, restarting: RefreshCw, crashed: OctagonX, stopping: Loader2, starting: Loader2, deleting: Loader2, 'delete-failed': OctagonX }
const SPINS = new Set(['starting', 'validating', 'restarting', 'stopping', 'deleting'])

function Pill({ tone, Icon, spin, children, className, ...rest }) {
  return (
    <Badge variant="outline" className={cn('gap-1 font-medium', TONE[tone], className)} {...rest}>
      <Icon className={cn('size-3', spin && 'animate-spin')} aria-hidden="true" />
      {children}
    </Badge>
  )
}

export function DeploymentStatusBadge({ status, className }) {
  const s = DEPLOYMENT_STATUS[status] ?? { label: status, tone: 'muted' }
  return <Pill tone={s.tone} Icon={DEPLOYMENT_ICON[status] ?? Clock} spin={SPINS.has(status)} className={className} data-status={status}>{s.label}</Pill>
}

export function RuntimeBadge({ state, className }) {
  const s = RUNTIME_STATE[state] ?? TRANSITION_STATE[state]
  if (!s) return <Pill tone="muted" Icon={PauseCircle} className={className}>Not started</Pill>
  return <Pill tone={s.tone} Icon={RUNTIME_ICON[state]} spin={SPINS.has(state)} className={className} data-runtime={state}>{s.label}</Pill>
}
