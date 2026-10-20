import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlertCircle, ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useGithub } from '@/lib/queries'
import { errorMessage } from '@/lib/githubconnect'
import { GithubConnectCard } from '@/components/github-connect-card'
import { GithubManualCard } from '@/components/github-manual-card'
import { GithubConnectedCard } from '@/components/github-connected-card'
import { GithubWebhookCard } from '@/components/github-webhook-card'
import { ListSkeleton, LoadError } from '@/components/states'

export default function GithubPage() {
  const github = useGithub()
  const [params, setParams] = useSearchParams()
  const [notice, setNotice] = useState(null)

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
      <h1 className="text-2xl font-semibold">GitHub</h1>
      <p className="text-sm text-muted-foreground">
        Shipdok reads your repositories through GitHub apps. Connect one for each GitHub account or organisation that has repositories you want to deploy, then choose
        which one each app uses.
      </p>
      {notice && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="size-4" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {github.isPending && <ListSkeleton rows={2} />}
      {github.isError && <LoadError error={github.error} title="Could not load the GitHub settings" onRetry={() => github.refetch()} />}
      {apps.map((app) => (
        <section key={app.id} aria-label={app.name ?? `GitHub app ${app.appId}`} className="space-y-4">
          <GithubConnectedCard app={app} />
          {!app.problem && <GithubWebhookCard app={app} />}
        </section>
      ))}
      {github.data && (
        <>
          <h2 className="text-lg font-semibold">{apps.length > 0 ? 'Add another GitHub app' : 'Connect a GitHub app'}</h2>
          <GithubConnectCard another={apps.length > 0} />
          <GithubManualCard />
        </>
      )}
    </div>
  )
}
