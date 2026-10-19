import { Link } from 'react-router-dom'
import { ExternalLink, GitBranch, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useApps, useStorage } from '@/lib/queries'
import { appAddress, displayState, timeAgo, shortSha } from '@/lib/format'
import { DeploymentStatusBadge, RuntimeBadge } from '@/components/status-badge'
import { Empty, ListSkeleton, LoadError } from '@/components/states'
import { StorageBanner } from '@/components/storage-banner'
import { formatCpu, formatMemory } from '@/lib/stats'
import { RepoLink } from '@/components/repo-link'

export function AppCard({ app }) {
  const latest = app.latest_deployment
  const stoppedOnPurpose = app.desired_state === 'stopped'
  return (
    <Card className="transition-colors hover:border-primary/50">
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/apps/${app.id}`} className="truncate text-base font-semibold hover:underline">{app.name}</Link>
            <RuntimeBadge state={displayState(app)} />
            {stoppedOnPurpose && !app.deleting_at && <Badge variant="secondary">Stopped on purpose</Badge>}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <RepoLink repo={app.repo} />
            <span className="inline-flex items-center gap-1"><GitBranch className="size-3.5" aria-hidden="true" />{app.branch}</span>
          </p>
          {app.stats && !app.deleting_at && (
            <p className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
              <span>CPU {formatCpu(app.stats.cpuPercent)}</span>
              <span>Memory {formatMemory(app.stats)}</span>
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1 text-sm sm:items-end">
          {latest ? (
            <div className="flex items-center gap-2">
              <DeploymentStatusBadge status={latest.status} />
              <span className="font-mono text-xs text-muted-foreground">{shortSha(latest.commit_sha)}</span>
              <span className="text-muted-foreground">{timeAgo(latest.finished_at ?? latest.queued_at)}</span>
            </div>
          ) : <span className="text-muted-foreground">Never deployed</span>}
          {!app.deleting_at && (
            <a href={appAddress(app)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
              :{app.running_settings?.host_port ?? app.host_port}<ExternalLink className="size-3" aria-hidden="true" /><span className="sr-only">Open the app</span>
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export default function AppsPage() {
  const apps = useApps()
  const storage = useStorage()
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Apps</h1>
        <Button asChild><Link to="/apps/new"><Plus className="size-4" />New app</Link></Button>
      </div>
      <StorageBanner disk={storage.data?.disk} />
      {apps.isPending && <ListSkeleton />}
      {apps.isError && <LoadError error={apps.error} onRetry={() => apps.refetch()} title="Could not load your apps" />}
      {apps.data?.length === 0 && (
        <Empty title="No apps yet">Create one from a GitHub repository and Shipdok will build and run it.</Empty>
      )}
      <div className="space-y-3">{apps.data?.map((app) => <AppCard key={app.id} app={app} />)}</div>
    </div>
  )
}
