import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { shortSha, timeAgo } from '@/lib/format'

/** Deleting a deployment is permanent, so it asks once. (The API already refuses the dangerous cases.) */
export function DeleteDeploymentDialog({ app, deployment, removesImage, onClose }) {
  const client = useQueryClient()
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
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete deployment {shortSha(deployment.commit_sha)}?</AlertDialogTitle>
          <AlertDialogDescription>
            From {timeAgo(deployment.queued_at)}. This removes the record and its build log for good.
            {removesImage ? ' Its saved image is removed too, so it can no longer be rolled back to.' : ''}
            {' '}The app's own output (runtime log) is not touched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={del.isPending} onClick={(e) => { e.preventDefault(); del.mutate() }}>Delete deployment</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
