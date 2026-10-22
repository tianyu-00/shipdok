import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

/** What the version says, and how to update. Shipdok never updates itself: the commands are run on the machine that hosts it. */
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
      {updateAvailable && <p>Version <strong>{latest}</strong> is available.</p>}
      {!updateAvailable && !error && latest && <p className="text-muted-foreground">You are up to date (newest is {latest}).</p>}
      {error && <p className="text-muted-foreground">{error === 'unreachable' ? 'Could not look for updates just now. Is this machine online?' : 'No published version was found.'}</p>}
      {updateAvailable && (
        <div className="space-y-2">
          <p className="text-muted-foreground">Back up first. Then, on the machine that runs Shipdok, in the folder with compose.yaml (if you pinned SHIPDOK_VERSION, change it to {latest} first):</p>
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">docker compose pull</pre>
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">docker compose up -d</pre>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Checked {new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <Button variant="outline" size="sm" disabled={again.isPending} onClick={() => again.mutate()}>{again.isPending ? 'Checking…' : 'Check now'}</Button>
      </div>
      {again.isError && <p className="text-xs text-destructive">Could not check just now.</p>}
    </div>
  )
}
