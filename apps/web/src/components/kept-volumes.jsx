import { useState } from 'react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { useKeptVolumes } from '@/lib/queries'
import { timeAgo } from '@/lib/format'
import { Empty, LoadError } from '@/components/states'

const origin = (v) => (v.state === 'orphaned' ? `Left behind by the deleted app ${v.appName}` : `Removed from ${v.appName}`)

function DeleteVolume({ volume }) {
  const client = useQueryClient()
  const [asking, setAsking] = useState(false)
  const del = useMutation({
    mutationFn: () => api(`/volumes/${volume.id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('Deleting the volume…'); client.invalidateQueries({ queryKey: ['kept-volumes'] }) },
    onError: (err) => toast.error(err.message),
    onSettled: () => setAsking(false),
  })
  return (
    <>
      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setAsking(true)}>Delete</Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this volume and its data?</AlertDialogTitle>
            <AlertDialogDescription>
              {volume.path} ({origin(volume)}) is removed from Docker together with every file in it. This is permanent: the data cannot be recovered afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={(e) => { e.preventDefault(); del.mutate() }}>Delete volume</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** Volumes whose data is kept but that no app mounts: a path that was removed, or an app that was deleted with its data kept. */
export default function KeptVolumes() {
  const kept = useKeptVolumes()
  const volumes = kept.data?.volumes ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Volumes kept without an app</CardTitle>
        <CardDescription>Data that is kept on purpose: a path removed from an app's persistent storage, or the files of an app that was deleted. Nothing here is deleted unless you delete it.</CardDescription>
      </CardHeader>
      <CardContent>
        {kept.isError && <LoadError error={kept.error} title="Could not load the kept volumes" onRetry={() => kept.refetch()} />}
        {kept.data && volumes.length === 0 && <Empty title="No volumes are being kept without being mounted" />}
        {volumes.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader><TableRow><TableHead>Path</TableHead><TableHead>Where from</TableHead><TableHead>Docker name</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {volumes.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-mono">{v.path}</TableCell>
                    <TableCell>
                      <p>{origin(v)}</p>
                      <p className="text-xs text-muted-foreground">{timeAgo(v.stateChangedAt)}</p>
                      {v.removeError && <p role="status" className="text-xs text-destructive">{v.removeError}</p>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{v.dockerName}</TableCell>
                    <TableCell className="text-right"><DeleteVolume volume={v} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
