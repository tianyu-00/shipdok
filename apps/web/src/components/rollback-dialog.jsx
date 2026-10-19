import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { shortSha, timeAgo } from '@/lib/format'

/** Roll back to an earlier version: the saved image runs again, nothing is cloned or built. A stopped app stays stopped unless asked. */
export function RollbackDialog({ app, deployment, onClose }) {
  const client = useQueryClient()
  const stopped = app.desired_state === 'stopped'
  const rollback = useMutation({
    mutationFn: (start) => api(`/apps/${app.id}/rollback`, { method: 'POST', body: { deploymentId: deployment.id, ...(start ? { start: true } : {}) } }),
    onSuccess: () => {
      toast.success('Rollback queued')
      onClose()
      for (const key of ['deployments', 'images']) client.invalidateQueries({ queryKey: [key, app.id] })
      client.invalidateQueries({ queryKey: ['app', app.id] })
      client.invalidateQueries({ queryKey: ['apps'] })
    },
    onError: (err) => toast.error(err.message),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Roll back to {shortSha(deployment.commit_sha)}?</DialogTitle>
          <DialogDescription>
            Version from {timeAgo(deployment.finished_at ?? deployment.queued_at)}. Its saved image runs again, with no new build, after the usual
            health check. The app keeps its current settings and variables; only the code is the old one.
            {stopped && ' The app is stopped, so it stays stopped unless you choose to start it.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {stopped && <Button variant="outline" disabled={rollback.isPending} onClick={() => rollback.mutate(true)}>Roll back and start</Button>}
          <Button disabled={rollback.isPending} onClick={() => rollback.mutate(false)}>Roll back</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
