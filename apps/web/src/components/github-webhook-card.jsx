import { Link } from 'react-router-dom'
import { Webhook } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api'
import { useGithubWebhook } from '@/lib/queries'
import { LoadError } from '@/components/states'

/** Is GitHub sending pushes to the address Shipdok expects (the public address + the webhook path)? Fix it with one click. */
export function GithubWebhookCard() {
  const client = useQueryClient()
  const hook = useGithubWebhook(true)
  const sync = useMutation({
    mutationFn: () => api('/github/webhook/sync', { method: 'POST' }),
    onSuccess: () => { toast.success('Webhook address updated on GitHub'); client.invalidateQueries({ queryKey: ['github-webhook'] }) },
    onError: (err) => toast.error(err.message),
  })
  const d = hook.data
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Webhook className="size-4" aria-hidden="true" />Webhook address</CardTitle>
        <CardDescription>GitHub tells Shipdok about pushes by calling this address. It is your public address followed by the webhook path.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {hook.isPending && <p className="text-sm text-muted-foreground">Asking GitHub…</p>}
        {hook.isError && <LoadError error={hook.error} title="Could not read the webhook address from GitHub" onRetry={() => hook.refetch()} />}
        {d && d.expected === null && (
          <p className="text-sm text-warning">
            No public address is set, so Shipdok does not know where GitHub should send pushes. Set one under <Link to="/security" className="underline">Public access</Link>:
            the app is then updated for you.
          </p>
        )}
        {d && d.expected && d.matches && (
          <>
            <p className="text-sm text-success">GitHub sends pushes to the right address.</p>
            <p className="text-sm"><code className="rounded bg-muted px-1 py-0.5">{d.expected}</code></p>
          </>
        )}
        {d && d.expected && !d.matches && (
          <>
            <p className="text-sm text-warning">GitHub is sending pushes to a different address, so pushes will not deploy.</p>
            <p className="text-sm text-muted-foreground">GitHub has: <code className="rounded bg-muted px-1 py-0.5">{d.actual ?? 'nothing'}</code></p>
            <p className="text-sm text-muted-foreground">Shipdok expects: <code className="rounded bg-muted px-1 py-0.5">{d.expected}</code></p>
            <Button onClick={() => sync.mutate()} disabled={sync.isPending}>{sync.isPending ? 'Please wait…' : 'Update on GitHub'}</Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
