import { useState } from 'react'
import { ScrollText, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { useDeployments } from '@/lib/queries'
import { deploymentReason, formatDuration, isActiveDeployment, shortSha, timeAgo } from '@/lib/format'
import { DeploymentStatusBadge } from '@/components/status-badge'
import { Empty, ListSkeleton, LoadError } from '@/components/states'
import { LogViewer } from '@/components/log-viewer'

const TRIGGER = { manual: 'Manual', webhook: 'Push', rollback: 'Rollback' }

export default function DeploymentsTab({ app }) {
  const client = useQueryClient()
  const deployments = useDeployments(app.id)
  const [logFor, setLogFor] = useState(null)

  const cancel = useMutation({
    mutationFn: (id) => api(`/deployments/${id}/cancel`, { method: 'POST' }),
    onSuccess: (d) => { toast.success(d.status === 'cancelled' ? 'Cancelled' : 'Stop requested'); client.invalidateQueries({ queryKey: ['deployments', app.id] }) },
    onError: (err) => toast.error(err.message),
  })

  if (deployments.isPending) return <ListSkeleton rows={2} />
  if (deployments.isError) return <LoadError error={deployments.error} onRetry={() => deployments.refetch()} title="Could not load the deployments" />
  if (deployments.data.length === 0) return <Empty title="No deployments yet">Press Deploy to build this app for the first time.</Empty>

  return (
    <>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead><TableHead>Commit</TableHead><TableHead>Started</TableHead><TableHead>Took</TableHead>
              <TableHead>Why</TableHead><TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deployments.data.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <DeploymentStatusBadge status={d.status} />
                    {d.trigger !== 'manual' && <Badge variant="outline">{TRIGGER[d.trigger] ?? d.trigger}</Badge>}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">{shortSha(d.commit_sha)}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{timeAgo(d.queued_at)}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDuration(d.started_at, d.finished_at)}</TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground" title={deploymentReason(d) ?? undefined}>{deploymentReason(d) ?? ''}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setLogFor(d)}><ScrollText className="size-4" />Log</Button>
                    {isActiveDeployment(d.status) && (
                      <Button variant="ghost" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(d.id)}><XCircle className="size-4" />Cancel</Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={logFor !== null} onOpenChange={(open) => !open && setLogFor(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Build log</DialogTitle>
            <DialogDescription>{logFor && `${shortSha(logFor.commit_sha)} · ${timeAgo(logFor.queued_at)}`}</DialogDescription>
          </DialogHeader>
          {logFor && <LogViewer key={logFor.id} path={`/deployments/${logFor.id}/logs`} emptyText="This deployment has no log (it may have been deleted)." />}
        </DialogContent>
      </Dialog>
    </>
  )
}
