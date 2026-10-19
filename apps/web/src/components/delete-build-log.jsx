import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'

/** Removes one deployment's build log for good (the deployment and its status stay). Only offered once it has finished. */
export function DeleteBuildLog({ deployment, onDeleted }) {
  const client = useQueryClient()
  const [asking, setAsking] = useState(false)
  const del = useMutation({
    mutationFn: () => api(`/deployments/${deployment.id}/logs`, { method: 'DELETE' }),
    onSuccess: (r) => { toast.success(`Log deleted (${formatBytes(r.freedBytes)})`); client.invalidateQueries({ queryKey: ['storage'] }); onDeleted() },
    onError: (err) => toast.error(err.message),
    onSettled: () => setAsking(false),
  })
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setAsking(true)}><Trash2 className="size-4" />Delete this log</Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this build log?</AlertDialogTitle>
            <AlertDialogDescription>The log is removed for good. The deployment itself, its status and its image stay.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); del.mutate() }}>Delete log</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
