import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, LoadError } from '@/components/states'
import { DeploymentStatusBadge } from '@/components/status-badge'
import { useCrashes, useDeployments } from '@/lib/queries'
import { shortSha, timeAgo } from '@/lib/format'
import { runningSetting } from '@/lib/settings'
import { PendingSettings } from '@/components/pending-settings'

const CAUSE = { crash: 'Crashed', stopped_outside: 'Stopped outside Shipdok', recovered: 'Recovered after a restart of the host or Docker' }

function Fact({ label, children }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  )
}

export default function OverviewTab({ app }) {
  const deployments = useDeployments(app.id)
  const crashes = useCrashes(app.id)
  const rt = app.runtime
  const latest = deployments.data?.[0]
  const live = deployments.data?.find((d) => d.status === 'successful')

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="lg:col-span-2 empty:hidden"><PendingSettings app={app} /></div>
      <Card>
        <CardHeader><CardTitle className="text-base">Running now</CardTitle></CardHeader>
        <CardContent>
          {live ? (
            <dl className="grid grid-cols-2 gap-4">
              <Fact label="Version"><span className="font-mono">{shortSha(live.commit_sha)}</span></Fact>
              <Fact label="Deployed">{timeAgo(live.finished_at)}</Fact>
              <Fact label="Port">container {runningSetting(app, 'container_port')} → host {runningSetting(app, 'host_port')}</Fact>
              <Fact label="Health check">{runningSetting(app, 'health_path') ?? 'none (any answer counts)'}</Fact>
              <Fact label="Memory limit">{runningSetting(app, 'memory_mb')} MB</Fact>
              <Fact label="CPU limit">{Number(runningSetting(app, 'cpus'))} CPU</Fact>
            </dl>
          ) : <p className="text-sm text-muted-foreground">Nothing has been deployed yet. Press Deploy to build and start this app.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Status</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {rt ? (
            <dl className="grid grid-cols-2 gap-4">
              <Fact label="Last action">{rt.last_action ?? '—'}</Fact>
              <Fact label="Updated">{timeAgo(rt.updated_at)}</Fact>
              {rt.last_exit_code !== null && rt.last_exit_code !== undefined && <Fact label="Last exit code">{rt.last_exit_code}{rt.oom_killed && ' (ran out of memory)'}</Fact>}
              {rt.health_failures > 0 && <Fact label="Failed health checks in a row">{rt.health_failures}</Fact>}
              {rt.next_restart_at && <Fact label="Next automatic restart">{timeAgo(rt.next_restart_at)}</Fact>}
            </dl>
          ) : <p className="text-muted-foreground">The worker has not reported on this app yet.</p>}
          {rt?.last_error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive" role="status">{rt.last_error}</p>}
          {latest && (
            <div className="flex items-center gap-2 border-t pt-3">
              <span className="text-muted-foreground">Latest deployment</span>
              <DeploymentStatusBadge status={latest.status} />
              <span className="text-muted-foreground">{timeAgo(latest.queued_at)}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader><CardTitle className="text-base">Crash history</CardTitle></CardHeader>
        <CardContent>
          {crashes.isError && <LoadError error={crashes.error} title="Could not load the crash history" onRetry={() => crashes.refetch()} />}
          {crashes.data?.length === 0 && <Empty title="No crashes recorded" />}
          <ul className="divide-y text-sm">
            {crashes.data?.map((c, i) => (
              <li key={`${c.occurred_at}-${i}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                <span className="w-28 shrink-0 text-muted-foreground">{timeAgo(c.occurred_at)}</span>
                <span className="font-medium">{CAUSE[c.cause] ?? c.cause}</span>
                {c.exit_code !== null && <span className="text-muted-foreground">exit {c.exit_code}{c.oom_killed && ', out of memory'}</span>}
                <span className="text-muted-foreground">{c.action}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
