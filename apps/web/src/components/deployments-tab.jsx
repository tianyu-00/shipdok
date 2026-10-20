import { Fragment, useEffect, useState } from 'react'
import { ChevronRight, RotateCcw, ScrollText, Trash2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { useDeployments, useImages } from '@/lib/queries'
import { deleteBlockedReason, deleteRemovesImage, versionsById } from '@/lib/versions'
import { DEPLOYMENT_STATUS, deploymentReason, formatDuration, isActiveDeployment, shortSha, timeAgo } from '@/lib/format'
import { DeploymentStatusBadge } from '@/components/status-badge'
import { Empty, ListSkeleton, LoadError } from '@/components/states'
import { LogViewer } from '@/components/log-viewer'
import { RollbackDialog } from '@/components/rollback-dialog'
import { DeleteDeploymentDialog } from '@/components/delete-deployment-dialog'
import { VersionBadge } from '@/components/version-badge'
import { DeleteBuildLog } from '@/components/delete-build-log'

// Pressing a row twice quickly would make the browser select the word under the pointer, and the "ignore a press that ended a selection" rule in
// toggleLog would then swallow the next press. A double press never starts a selection; a single press can still start a drag to select text.
const noWordSelection = (e) => { if (e.detail > 1) e.preventDefault() }

const TRIGGER = { manual: 'Manual', webhook: 'Push', rollback: 'Rollback' }

// Why a deployment did not end in success, above its log (it stays visible when the log itself has been deleted).
const REASON_TONE = {
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  muted: 'border-border bg-muted/50 text-muted-foreground',
}
function Reason({ deployment }) {
  const reason = deploymentReason(deployment)
  if (!reason) return null
  const status = DEPLOYMENT_STATUS[deployment.status]
  return (
    <p data-testid="deployment-reason" className={`rounded-md border px-3 py-2 text-sm ${REASON_TONE[status?.tone] ?? REASON_TONE.muted}`}>
      {reason === status?.label ? <span className="font-medium">{reason}</span> : <><span className="font-medium">{status?.label ?? deployment.status}:</span> {reason}</>}
    </p>
  )
}

// A button that cannot be used says why (a title, and for screen readers a description), instead of just being grey.
function DeleteButton({ reason, onClick }) {
  return (
    <span title={reason ?? undefined}>
      <Button variant="ghost" size="icon-sm" disabled={reason !== null} aria-label={reason ? `Delete (unavailable: ${reason})` : 'Delete'} title={reason ?? 'Delete this deployment'} onClick={onClick}>
        <Trash2 className="size-4" />
      </Button>
    </span>
  )
}

export default function DeploymentsTab({ app }) {
  const client = useQueryClient()
  const deployments = useDeployments(app.id)
  const images = useImages(app.id) // a failure here only hides the version labels and the rollback/delete buttons
  const versions = versionsById(images.data)
  // A deployment appearing or finishing changes which version is live, so the labels are re-read at once, not on the next poll.
  const signature = (deployments.data ?? []).map((d) => `${d.id}:${d.status}`).join()
  const { refetch: refetchImages } = images
  useEffect(() => { if (signature) refetchImages() }, [signature, refetchImages])
  const [openLogs, setOpenLogs] = useState(() => new Set()) // the deployments whose log is open under their row (several can be)
  // Pressing anywhere on a row opens or closes its log, unless the press ended a text selection (someone copying a commit id).
  const toggleLog = (id) => { if (window.getSelection?.()?.toString()) return; setLogOpen(id, !openLogs.has(id)) }
  const setLogOpen = (id, open) => setOpenLogs((old) => { const next = new Set(old); if (open) next.add(id); else next.delete(id); return next })
  const [rollbackFor, setRollbackFor] = useState(null)
  const [deleteFor, setDeleteFor] = useState(null)

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
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deployments.data.map((d) => (
              <Fragment key={d.id}>
              <TableRow data-state={openLogs.has(d.id) ? 'open' : undefined} className={`cursor-pointer ${openLogs.has(d.id) ? 'border-b-0' : ''}`} onClick={() => toggleLog(d.id)} onMouseDown={noWordSelection}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${openLogs.has(d.id) ? 'rotate-90' : ''}`} aria-hidden="true" />
                    <DeploymentStatusBadge status={d.status} />
                    {d.trigger !== 'manual' && <Badge variant="outline">{TRIGGER[d.trigger] ?? d.trigger}</Badge>}
                    {versions.get(d.id) && <VersionBadge state={versions.get(d.id).state} />}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">{shortSha(d.commit_sha)}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{timeAgo(d.queued_at)}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDuration(d.started_at, d.finished_at)}</TableCell>
                {/* The buttons keep their own click: pressing one must not also open or close the log. */}
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" aria-expanded={openLogs.has(d.id)} aria-controls={`log-${d.id}`} aria-label={openLogs.has(d.id) ? 'Hide log' : 'Log'} title={openLogs.has(d.id) ? 'Hide log' : 'Show log'} onClick={() => setLogOpen(d.id, !openLogs.has(d.id))}>
                      <ScrollText className="size-4" />
                    </Button>
                    {isActiveDeployment(d.status) && (
                      <Button variant="ghost" size="icon-sm" aria-label="Cancel" title="Cancel this deployment" disabled={cancel.isPending} onClick={() => cancel.mutate(d.id)}><XCircle className="size-4" /></Button>
                    )}
                    {versions.get(d.id)?.canRollBackTo && (
                      <Button variant="ghost" size="icon-sm" aria-label="Roll back" title="Roll back to this version" onClick={() => setRollbackFor(d)}><RotateCcw className="size-4" /></Button>
                    )}
                    {images.data && !isActiveDeployment(d.status) && <DeleteButton reason={deleteBlockedReason(d, images.data)} onClick={() => setDeleteFor(d)} />}
                  </div>
                </TableCell>
              </TableRow>
              {openLogs.has(d.id) && (
                <TableRow id={`log-${d.id}`} className="bg-muted/30 hover:bg-muted/30">
                  {/* max-w-0: the console must not make the table wider, it takes the width the other columns already gave it. */}
                  <TableCell colSpan={5} className="max-w-0 whitespace-normal p-3">
                    {/* Sticky and never wider than the screen, so on a phone the console stays in view while the table scrolls sideways. */}
                    <div className="sticky left-0 w-[min(100%,calc(100vw-3.5rem))] space-y-2">
                      <Reason deployment={d} />
                      <LogViewer
                        key={d.id} path={`/deployments/${d.id}/logs`} title={`Build log · ${shortSha(d.commit_sha)} · ${timeAgo(d.queued_at)}`}
                        filename={`${app.slug}-${shortSha(d.commit_sha)}-build.log`} emptyText="This deployment has no log (it may have been deleted)."
                      />
                      {!isActiveDeployment(d.status) && <div className="flex justify-end"><DeleteBuildLog deployment={d} onDeleted={() => setLogOpen(d.id, false)} /></div>}
                    </div>
                  </TableCell>
                </TableRow>
              )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>

      {rollbackFor && <RollbackDialog app={app} deployment={rollbackFor} onClose={() => setRollbackFor(null)} />}
      {deleteFor && <DeleteDeploymentDialog app={app} deployment={deleteFor} removesImage={deleteRemovesImage(deleteFor, images.data)} onClose={() => setDeleteFor(null)} />}
    </>
  )
}
