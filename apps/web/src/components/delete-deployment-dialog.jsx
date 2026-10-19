import { useState } from 'react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { shortSha, timeAgo } from '@/lib/format'

/** Deleting a deployment is permanent, so the app's name has to be typed. */
export function DeleteDeploymentDialog({ app, deployment, removesImage, onClose }) {
  const client = useQueryClient()
  const [typed, setTyped] = useState('')
  const del = useMutation({
    mutationFn: () => api(`/deployments/${deployment.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Deployment deleted')
      onClose()
      for (const key of ['deployments', 'images']) client.invalidateQueries({ queryKey: [key, app.id] })
      client.invalidateQueries({ queryKey: ['storage'] })
    },
    onError: (err) => { toast.error(err.message); onClose() },
  })
  const matches = typed === app.name
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete deployment {shortSha(deployment.commit_sha)}?</DialogTitle>
          <DialogDescription>
            From {timeAgo(deployment.queued_at)}. This removes the record and its build log for good.
            {removesImage ? ' Its saved image is removed too, so it can no longer be rolled back to.' : ''}
            {' '}The app's own output (runtime log) is not touched.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (matches && !del.isPending) del.mutate() }}>
          <Label htmlFor="confirm-name">Type <span className="font-mono font-semibold">{app.name}</span> to confirm</Label>
          <Input id="confirm-name" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={!matches || del.isPending} onClick={() => del.mutate()}>Delete deployment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
