import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, CircleCheck, TriangleAlert, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api'
import { installUrl } from '@/lib/githubconnect'
import { useGithubWebhook } from '@/lib/queries'
import { GithubDisconnectDialog } from '@/components/github-disconnect-dialog'

const SOURCE = { manifest: "Created by Shipdok's Connect GitHub button", manual: 'Entered by hand' }
const Code = ({ children }) => <code className="rounded bg-muted px-1 py-0.5 break-all">{children}</code>

/**
 * How this app's webhook stands, in one glance: a green mark when GitHub sends pushes to the address Shipdok expects, an amber one with the
 * way to fix it when it does not. The two addresses are only spelled out (in the card) when they differ.
 */
function WebhookStatus({ hook, fix }) {
  const d = hook.data
  if (hook.isPending) return <span className="text-sm text-muted-foreground">Checking webhook…</span>
  if (hook.isError) return <span className="inline-flex items-center gap-1 text-sm text-warning"><TriangleAlert className="size-4" aria-hidden="true" />Webhook not checked</span>
  if (d.expected === null) return <span className="inline-flex items-center gap-1 text-sm text-warning"><TriangleAlert className="size-4" aria-hidden="true" />No public address</span>
  if (d.matches) return <span className="inline-flex items-center gap-1 text-sm text-success"><CircleCheck className="size-4" aria-hidden="true" />Webhook OK</span>
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center gap-1 text-sm text-warning"><TriangleAlert className="size-4" aria-hidden="true" />Webhook address differs</span>
      <Button size="sm" onClick={() => fix.mutate()} disabled={fix.isPending}>{fix.isPending ? 'Please wait…' : 'Update on GitHub'}</Button>
    </span>
  )
}

/** One connected GitHub app: its webhook status, the projects that use it, where it is installed (asked on demand) and Disconnect. */
export function GithubAppCard({ app }) {
  const client = useQueryClient()
  const [disconnecting, setDisconnecting] = useState(false)
  const unreadable = app.problem === 'cannot_decrypt'
  const installations = useQuery({ queryKey: ['github-installations', app.id], queryFn: () => api(`/github/apps/${app.id}/installations`), enabled: false, retry: false })
  const hook = useGithubWebhook(app.id, !unreadable)
  const fix = useMutation({
    mutationFn: () => api(`/github/apps/${app.id}/webhook/sync`, { method: 'POST' }),
    onSuccess: () => { toast.success('Webhook address updated on GitHub'); client.invalidateQueries({ queryKey: ['github-webhook', app.id] }) },
    onError: (err) => toast.error(err.message),
  })
  const link = installUrl(app.slug)
  const d = hook.data
  const found = installations.data?.installations
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">{app.name ?? app.slug ?? `GitHub app ${app.appId}`}</CardTitle>
            <CardDescription>{app.ownerLogin ? `GitHub account: ${app.ownerLogin}` : 'GitHub app'}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {!unreadable && <WebhookStatus hook={hook} fix={fix} />}
            <Button variant="outline" size="sm" onClick={() => setDisconnecting(true)}>Disconnect</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {unreadable && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="size-4" />
            <AlertDescription>The stored credentials cannot be read. This usually means APP_SECRETS_KEY was changed. Disconnect this app and connect it again to replace its credentials. The other GitHub apps are not affected.</AlertDescription>
          </Alert>
        )}

        {hook.isError && (
          <p role="alert" className="text-sm text-destructive">
            {hook.error.message} <button type="button" className="underline" onClick={() => hook.refetch()}>Try again</button>
          </p>
        )}
        {d && d.expected === null && (
          <p className="text-sm text-warning">
            No public address is set, so Shipdok does not know where GitHub should send pushes. Set one under <Link to="/security" className="underline">Public access</Link>:
            the app is then updated for you.
          </p>
        )}
        {d && d.expected && !d.matches && (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>GitHub is sending pushes to a different address, so pushes will not deploy.</p>
            <p>GitHub has: <Code>{d.actual ?? 'nothing'}</Code></p>
            <p>Shipdok expects: <Code>{d.expected}</Code></p>
          </div>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">On GitHub</dt>
          <dd>{app.htmlUrl ? <a href={app.htmlUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">{app.name ?? app.slug}<ExternalLink className="size-3" aria-hidden="true" /></a> : (app.name ?? app.slug)}</dd>
          <dt className="text-muted-foreground">App ID</dt>
          <dd>{app.appId}</dd>
        </dl>
        {!unreadable && link && (
          <Button variant="outline" size="sm" asChild className="w-fit"><a href={link} target="_blank" rel="noreferrer">Install on repositories<ExternalLink className="size-4" aria-hidden="true" /></a></Button>
        )}

        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Details</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Used by</dt>
            <dd>
              {app.projects?.length
                ? app.projects.map((p, i) => <span key={p.id}>{i > 0 ? ', ' : ''}<Link to={`/apps/${p.id}`} className="underline">{p.name}</Link></span>)
                : <span className="text-muted-foreground">No project yet</span>}
            </dd>
            {!unreadable && (
              <>
                <dt className="text-muted-foreground">Installed on</dt>
                <dd>
                  {found === undefined && <span className="text-muted-foreground">Press Check again to look</span>}
                  {found?.length === 0 && <span className="text-muted-foreground">Not installed on any account yet.</span>}
                  {found?.length > 0 && (
                    <>
                      <span className="text-muted-foreground">Installed on:</span>
                      <ul className="list-disc pl-5">{found.map((i) => <li key={i.id}>{i.account ?? `installation ${i.id}`}</li>)}</ul>
                    </>
                  )}
                  {installations.isError && <span role="alert" className="text-destructive">{installations.error.message}</span>}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Added</dt>
            <dd>{SOURCE[app.source] ?? app.source}, {new Date(app.connectedAt).toLocaleDateString()}</dd>
            {d?.expected && <><dt className="text-muted-foreground">Webhook address</dt><dd><Code>{d.expected}</Code></dd></>}
          </dl>
          {!unreadable && (
            <div className="mt-3">
              <Button variant="ghost" size="sm" onClick={() => installations.refetch()} disabled={installations.isFetching}>{installations.isFetching ? 'Checking…' : 'Check again'}</Button>
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">The app's key and webhook secret are stored encrypted and are never shown.</p>
        </details>
        {disconnecting && <GithubDisconnectDialog app={app} onClose={() => setDisconnecting(false)} />}
      </CardContent>
    </Card>
  )
}
