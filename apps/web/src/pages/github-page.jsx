import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlertCircle, ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useGithub } from '@/lib/queries'
import { errorMessage } from '@/lib/githubconnect'
import { GithubConnectCard } from '@/components/github-connect-card'
import { GithubManualCard } from '@/components/github-manual-card'
import { GithubConnectedCard } from '@/components/github-connected-card'
import { GithubWebhookCard } from '@/components/github-webhook-card'
import { GithubDisconnectDialog } from '@/components/github-disconnect-dialog'
import { ListSkeleton, LoadError } from '@/components/states'

export default function GithubPage() {
  const github = useGithub()
  const [params, setParams] = useSearchParams()
  const [notice, setNotice] = useState(null)
  const [disconnecting, setDisconnecting] = useState(false)

  // GitHub sends the browser back here with ?connected=1 or ?error=<reason>: say it once and tidy the address.
  useEffect(() => {
    if (params.get('connected')) toast.success('GitHub connected')
    const error = params.get('error')
    if (error) setNotice(errorMessage(error))
    if (params.get('connected') || error) setParams({}, { replace: true })
  }, [params, setParams])

  const data = github.data
  return (
    <div className="space-y-6">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />All apps</Link>
      <h1 className="text-2xl font-semibold">GitHub</h1>
      {notice && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="size-4" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {github.isPending && <ListSkeleton rows={2} />}
      {github.isError && <LoadError error={github.error} title="Could not load the GitHub settings" onRetry={() => github.refetch()} />}
      {data?.problem === 'cannot_decrypt' && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="size-4" />
          <AlertDescription>
            <p>The stored GitHub credentials cannot be read. This usually means APP_SECRETS_KEY was changed. Disconnect and connect again to replace them.</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => setDisconnecting(true)}>Disconnect</Button>
          </AlertDescription>
        </Alert>
      )}
      {data?.connected && (
        <>
          <GithubConnectedCard app={data.app} />
          <GithubWebhookCard />
        </>
      )}
      {data && !data.connected && data.problem !== 'cannot_decrypt' && (
        <>
          <GithubConnectCard />
          <GithubManualCard />
        </>
      )}
      {disconnecting && <GithubDisconnectDialog onClose={() => setDisconnecting(false)} />}
    </div>
  )
}
