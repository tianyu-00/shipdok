import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

/** What the version says. An update is announced and pointed at the release notes; Shipdok never updates itself. */
export function UpdateDetails({ version }) {
  const client = useQueryClient()
  const again = useMutation({
    mutationFn: () => api('/version?fresh=1'),
    onSuccess: (data) => client.setQueryData(['version'], data),
  })
  const { current, latest, updateAvailable, error, checkedAt } = version
  return (
    <div className="space-y-3 p-4 text-sm">
      <p className="font-medium">{current ? `Shipdok ${current}` : 'Shipdok (version unknown)'}</p>
      {!updateAvailable && !error && latest && <p className="text-muted-foreground">You are up to date (newest is {latest}).</p>}
      {error && <p className="text-muted-foreground">{error === 'unreachable' ? 'Could not look for updates just now. Is this machine online?' : 'No published version was found.'}</p>}
      {updateAvailable && (
        <p className="text-muted-foreground">
          A new update (<strong className="text-foreground">{latest}</strong>) is available. See{' '}
          <a href="https://github.com/tianyu-00/shipdok/releases" target="_blank" rel="noreferrer" className="font-medium text-foreground underline">GitHub releases</a>{' '}
          for what changed.
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Checked {new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <Button variant="outline" size="sm" disabled={again.isPending} onClick={() => again.mutate()}>{again.isPending ? 'Checking…' : 'Check now'}</Button>
      </div>
      {again.isError && <p className="text-xs text-destructive">Could not check just now.</p>}
    </div>
  )
}
