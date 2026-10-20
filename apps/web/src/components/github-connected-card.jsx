import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, CircleCheck, ExternalLink } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api'
import { installUrl } from '@/lib/githubconnect'
import { GithubDisconnectDialog } from '@/components/github-disconnect-dialog'

const SOURCE = { manifest: "Created by Shipdok's Connect GitHub button", manual: 'Entered by hand' }

/** One connected GitHub app: who it is, the projects that use it, where it is installed (asked on demand), and Disconnect. */
export function GithubConnectedCard({ app }) {
  const [disconnecting, setDisconnecting] = useState(false)
  const installations = useQuery({ queryKey: ['github-installations', app.id], queryFn: () => api(`/github/apps/${app.id}/installations`), enabled: false, retry: false })
  const link = installUrl(app.slug)
  const unreadable = app.problem === 'cannot_decrypt'
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {unreadable ? <AlertCircle className="size-4 text-destructive" aria-hidden="true" /> : <CircleCheck className="size-4 text-success" aria-hidden="true" />}
          {app.name ?? app.slug ?? `GitHub app ${app.appId}`}
        </CardTitle>
        <CardDescription>
          {unreadable
            ? 'The stored credentials cannot be read.'
            : "Shipdok can read the repositories this app is installed on and gets their pushes. The app's key and webhook secret are stored encrypted and are never shown."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {unreadable && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="size-4" />
            <AlertDescription>This usually means APP_SECRETS_KEY was changed. Disconnect this app and connect it again to replace its credentials. The other GitHub apps are not affected.</AlertDescription>
          </Alert>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">App</dt>
          <dd>{app.htmlUrl ? <a href={app.htmlUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">{app.name ?? app.slug}<ExternalLink className="size-3" aria-hidden="true" /></a> : (app.name ?? app.slug)}</dd>
          <dt className="text-muted-foreground">App ID</dt>
          <dd>{app.appId}</dd>
          {app.ownerLogin && (<><dt className="text-muted-foreground">Owner</dt><dd>{app.ownerLogin}</dd></>)}
          <dt className="text-muted-foreground">Added</dt>
          <dd>{SOURCE[app.source] ?? app.source}, {new Date(app.connectedAt).toLocaleDateString()}</dd>
          <dt className="text-muted-foreground">Used by</dt>
          <dd>
            {app.projects?.length
              ? app.projects.map((p, i) => <span key={p.id}>{i > 0 ? ', ' : ''}<Link to={`/apps/${p.id}`} className="underline">{p.name}</Link></span>)
              : <span className="text-muted-foreground">No project yet</span>}
          </dd>
        </dl>

        {!unreadable && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Repositories</p>
            <p className="text-xs text-muted-foreground">The app only sees repositories you install it on. Install it on the ones you want to deploy, then check here.</p>
            <div className="flex flex-wrap gap-2">
              {link && <Button variant="outline" size="sm" asChild><a href={link} target="_blank" rel="noreferrer">Install on repositories<ExternalLink className="size-4" aria-hidden="true" /></a></Button>}
              <Button variant="ghost" size="sm" onClick={() => installations.refetch()} disabled={installations.isFetching}>{installations.isFetching ? 'Checking…' : 'Check again'}</Button>
            </div>
            {installations.isError && <p role="alert" className="text-sm text-destructive">{installations.error.message}</p>}
            {installations.data && (installations.data.installations.length === 0
              ? <p className="text-sm text-muted-foreground">Not installed on any account yet.</p>
              : (
                <div className="text-sm">
                  <p className="text-muted-foreground">Installed on:</p>
                  <ul className="list-disc pl-5">{installations.data.installations.map((i) => <li key={i.id}>{i.account ?? `installation ${i.id}`}</li>)}</ul>
                </div>
              ))}
          </div>
        )}

        <Button variant="outline" onClick={() => setDisconnecting(true)}>Disconnect</Button>
        {disconnecting && <GithubDisconnectDialog app={app} onClose={() => setDisconnecting(false)} />}
      </CardContent>
    </Card>
  )
}
