import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlertCircle, ArrowLeft, Plus, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useGithub } from '@/lib/queries'
import { errorMessage } from '@/lib/githubconnect'
import { timeAgo } from '@/lib/format'
import { GithubAddDialog } from '@/components/github-add-dialog'
import { GithubAppCard } from '@/components/github-app-card'
import { Empty, ListSkeleton, LoadError } from '@/components/states'

export default function GithubPage() {
  const github = useGithub()
  const client = useQueryClient()
  const dismiss = useMutation({
    mutationFn: (appNumber) => api(`/github/refusals/${appNumber ?? 'none'}`, { method: 'DELETE' }),
    onSettled: () => client.invalidateQueries({ queryKey: ['github'] }),
    onError: (err) => toast.error(err.message),
  })
  const [params, setParams] = useSearchParams()
  const [notice, setNotice] = useState(null)
  const [adding, setAdding] = useState(null) // null, or which way to add one is open: { tab, appId }

  // GitHub sends the browser back here with ?connected=<the new app's id> or ?error=<reason>: say it once and tidy the address.
  useEffect(() => {
    if (params.get('connected')) toast.success('GitHub app connected')
    const error = params.get('error')
    if (error) setNotice(errorMessage(error))
    if (params.get('connected') || error) setParams({}, { replace: true })
  }, [params, setParams])

  const apps = github.data?.apps ?? []
  const unknown = github.data?.unknownSenders ?? []
  return (
    <div className="space-y-6">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />All apps</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">GitHub</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Shipdok reads your repositories through GitHub apps. Connect one for each GitHub account or organisation that has repositories you want to deploy,
            then choose which one each app uses.
          </p>
        </div>
        {github.data && <Button onClick={() => setAdding({ tab: 'create', appId: '' })}><Plus className="size-4" aria-hidden="true" />Add a GitHub app</Button>}
      </div>
      {notice && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="size-4" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {unknown.map((u) => (
        <Alert key={u.appNumber ?? 'none'} role="note" className="border-warning/50 text-warning">
          <TriangleAlert className="size-4" aria-hidden="true" />
          <AlertDescription className="space-y-2">
            <p className="font-medium">
              {u.appNumber
                ? `A push came from GitHub App ID ${u.appNumber}, which is not connected to this Shipdok.`
                : 'A push was refused: GitHub did not say which app sent it, and its signature matches none of the connected apps.'}
            </p>
            <p>
              It was refused {timeAgo(u.at)}{u.count > 1 ? ` (${u.count} times)` : ''} and nothing was deployed.
              {u.appNumber ? ' If that is your app, add it with its App ID, private key and webhook secret, then choose it in the project\'s settings.' : ''}
            </p>
            <div className="flex flex-wrap gap-2">
              {u.appNumber && <Button variant="outline" size="sm" onClick={() => setAdding({ tab: 'existing', appId: u.appNumber })}>Add this app</Button>}
              <Button variant="ghost" size="sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate(u.appNumber)}>Dismiss</Button>
            </div>
          </AlertDescription>
        </Alert>
      ))}
      {github.isPending && <ListSkeleton rows={2} />}
      {github.isError && <LoadError error={github.error} title="Could not load the GitHub settings" onRetry={() => github.refetch()} />}
      {github.data && apps.length === 0 && (
        <Empty title="No GitHub app is connected">
          Public repositories can be deployed by hand without one. For private repositories, and to deploy on every push, add a GitHub app.
        </Empty>
      )}
      {apps.map((app) => <GithubAppCard key={app.id} app={app} onEnterAgain={(appId) => setAdding({ tab: 'existing', appId })} />)}
      <GithubAddDialog open={adding !== null} onOpenChange={(open) => !open && setAdding(null)} initialTab={adding?.tab} initialAppId={adding?.appId} />
    </div>
  )
}
