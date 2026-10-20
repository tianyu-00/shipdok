import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, HardDrive } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { useApps, useStorage } from '@/lib/queries'
import { formatBytes } from '@/lib/format'
import { storageRows } from '@/lib/storage'
import { Empty, ListSkeleton, LoadError } from '@/components/states'
import KeptVolumes from '@/components/kept-volumes'
import BuildCacheCard from '@/components/build-cache-card'

const LEVEL = {
  ok: { label: 'Plenty of space', className: 'border-success/40 bg-success/10 text-success' },
  low: { label: 'Getting full', className: 'border-warning/40 bg-warning/10 text-warning' },
  critical: { label: 'Almost full', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
}

function DiskCard({ disk }) {
  if (!disk) return null
  const used = disk.totalBytes - disk.freeBytes
  const usedPercent = Math.min(100, Math.max(0, Math.round((used / disk.totalBytes) * 100)))
  const level = LEVEL[disk.level] ?? LEVEL.ok
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><HardDrive className="size-4" aria-hidden="true" />Disk<Badge variant="outline" className={level.className}>{level.label}</Badge></CardTitle>
        <CardDescription>The disk the logs are stored on, which is normally the one Docker uses too. New builds are held back when under 10% is free.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${usedPercent}% used`}>
          <div className={disk.level === 'critical' ? 'h-full bg-destructive' : disk.level === 'low' ? 'h-full bg-warning' : 'h-full bg-primary'} style={{ width: `${usedPercent}%` }} />
        </div>
        <p className="text-sm text-muted-foreground">{formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)} ({disk.freePercent}% free)</p>
      </CardContent>
    </Card>
  )
}

function DeleteRuntimeLogs({ row }) {
  const client = useQueryClient()
  const [asking, setAsking] = useState(false)
  const del = useMutation({
    mutationFn: () => api(`/apps/${row.appId}/logs`, { method: 'DELETE' }),
    onSuccess: (r) => { toast.success(`Deleted the output logs (${formatBytes(r.freedBytes)})`); client.invalidateQueries({ queryKey: ['storage'] }) },
    onError: (err) => toast.error(err.message),
    onSettled: () => setAsking(false),
  })
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setAsking(true)}>Delete output logs</Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the output logs of {row.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The app's own output, the current run and the one before it, is removed for good. Build logs stay. If the app is running its output is still
              being collected and this is refused: stop the app first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); del.mutate() }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export default function StoragePage() {
  const storage = useStorage()
  const apps = useApps()
  const rows = storageRows(storage.data, apps.data)
  return (
    <div className="space-y-6">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />All apps</Link>
      <h1 className="text-2xl font-semibold">Storage</h1>
      {storage.isPending && <ListSkeleton rows={2} />}
      {storage.isError && <LoadError error={storage.error} title="Could not load the storage figures" onRetry={() => storage.refetch()} />}
      {storage.data && (
        <>
          <DiskCard disk={storage.data.disk} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">What each app takes</CardTitle>
              <CardDescription>
                Logs are kept until you delete them. Image sizes are upper bounds: versions of one app share files, so cleaning up usually frees less.
                Total: {formatBytes(storage.data.logs.totalBytes)} of logs, {formatBytes(storage.data.images.totalBytes)} of images.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? <Empty title="Nothing stored yet">Logs and images appear here after the first deployment.</Empty> : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>App</TableHead><TableHead>Logs</TableHead><TableHead>Images (up to)</TableHead><TableHead>Total</TableHead><TableHead className="text-right">Actions</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.appId}>
                          <TableCell className="font-medium"><Link to={`/apps/${r.appId}`} className="hover:underline">{r.name}</Link></TableCell>
                          <TableCell className="whitespace-nowrap">{formatBytes(r.logBytes)} <span className="text-muted-foreground">({r.logFiles} file{r.logFiles === 1 ? '' : 's'})</span></TableCell>
                          <TableCell className="whitespace-nowrap">{formatBytes(r.imageBytes)} <span className="text-muted-foreground">({r.images} image{r.images === 1 ? '' : 's'})</span></TableCell>
                          <TableCell className="whitespace-nowrap">{formatBytes(r.total)}</TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              <Button variant="ghost" size="sm" asChild><Link to={`/apps/${r.appId}/images`}>Images</Link></Button>
                              {r.logBytes > 0 && <DeleteRuntimeLogs row={r} />}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
          <BuildCacheCard />
          <KeptVolumes />
        </>
      )}
    </div>
  )
}
