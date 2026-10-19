import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'

/** Asks the API to delete the app (the worker then does it). Used by the dialog below and by "try again" after a failure. */
export function useDeleteApp(app, { onAccepted } = {}) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api(`/apps/${app.id}`, { method: 'DELETE', body: { confirm: app.name } }),
    onSuccess: () => {
      toast.success(`Deleting ${app.name}…`)
      client.setQueryData(['deleting', app.id], true)
      client.invalidateQueries({ queryKey: ['app', app.id] })
      client.invalidateQueries({ queryKey: ['apps'] })
      onAccepted?.()
    },
    onError: (err) => toast.error(err.message),
  })
}

/** The danger zone at the bottom of Settings. Deleting an app is permanent, so its name has to be typed. */
export function DeleteApp({ app }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const del = useDeleteApp(app, { onAccepted: () => setOpen(false) })
  const close = (next) => { setOpen(next); if (!next) setTyped('') }
  const matches = typed === app.name
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base text-destructive">Delete this app</CardTitle>
        <CardDescription>
          Stops and removes its container, removes all its images, and deletes its logs, variables and deployment history. This cannot be undone.
          The GitHub repository is not touched.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setOpen(true)}><Trash2 className="size-4" />Delete app…</Button>
      </CardContent>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {app.name}?</DialogTitle>
            <DialogDescription>
              {app.name} is stopped and removed, together with its images, logs, variables and deployment history. Recorded webhook deliveries stay as history.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (matches && !del.isPending) del.mutate() }}>
            <Label htmlFor="delete-confirm">Type <span className="font-mono font-semibold">{app.name}</span> to confirm</Label>
            <Input id="delete-confirm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
            <Button variant="destructive" disabled={!matches || del.isPending} onClick={() => del.mutate()}>Delete app</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
