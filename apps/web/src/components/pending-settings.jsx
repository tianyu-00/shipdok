import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { SETTING_LABELS } from '@/lib/settings'

/** Edited settings only reach the running app with the next deployment. Says which ones are still waiting. */
export function PendingSettings({ app }) {
  const pending = app.settings_pending ?? []
  if (pending.length === 0) return null
  return (
    <Alert className="border-warning/50 text-warning">
      <AlertTitle>These settings are not in the running app yet</AlertTitle>
      <AlertDescription>
        <p>{pending.map((k) => SETTING_LABELS[k] ?? k).join(', ')}. Press Deploy to apply {pending.length === 1 ? 'it' : 'them'}.</p>
      </AlertDescription>
    </Alert>
  )
}
