import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlertCircle, ArrowLeft, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useGithub } from '@/lib/queries'
import { errorMessage } from '@/lib/githubconnect'
import { GithubAddDialog } from '@/components/github-add-dialog'
import { GithubAppCard } from '@/components/github-app-card'
import { Empty, ListSkeleton, LoadError } from '@/components/states'

export default function GithubPage() {
  const github = useGithub()
  const [params, setParams] = useSearchParams()
  const [notice, setNotice] = useState(null)
  const [adding, setAdding] = useState(false)

  // GitHub sends the browser back here with ?connected=<the new app's id> or ?error=<reason>: say it once and tidy the address.
  useEffect(() => {
    if (params.get('connected')) toast.success('GitHub app connected')
    const error = params.get('error')
    if (error) setNotice(errorMessage(error))
    if (params.get('connected') || error) setParams({}, { replace: true })
  }, [params, setParams])

  const apps = github.data?.apps ?? []
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
        {github.data && <Button onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden="true" />Add a GitHub app</Button>}
      </div>
      {notice && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="size-4" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {github.isPending && <ListSkeleton rows={2} />}
      {github.isError && <LoadError error={github.error} title="Could not load the GitHub settings" onRetry={() => github.refetch()} />}
      {github.data && apps.length === 0 && (
        <Empty title="No GitHub app is connected">
          Public repositories can be deployed by hand without one. For private repositories, and to deploy on every push, add a GitHub app.
        </Empty>
      )}
      {apps.map((app) => <GithubAppCard key={app.id} app={app} />)}
      <GithubAddDialog open={adding} onOpenChange={setAdding} />
    </div>
  )
}
