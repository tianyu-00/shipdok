import { Download, Lock, ShieldCheck, Trash2 } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { formatBytes, timeAgo } from '@/lib/format'
import { volumesText } from '@/lib/backups'

const STATUS = {
  queued: { label: 'Waiting', className: 'border-info/40 bg-info/10 text-info' },
  running: { label: 'Making…', className: 'border-info/40 bg-info/10 text-info' },
  ok: { label: 'Done', className: 'border-success/40 bg-success/10 text-success' },
  failed: { label: 'Failed', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
}

function Row({ backup, showApp, onDownload, onDelete }) {
  const s = STATUS[backup.status] ?? STATUS.failed
  return (
    <TableRow>
      {showApp && (
        <TableCell className="font-medium">
          {backup.appName ?? 'An app'}
          {backup.volumeCount != null && <span className="block text-xs font-normal text-muted-foreground">{volumesText(backup.volumeCount)}</span>}
        </TableCell>
      )}
      <TableCell className="whitespace-nowrap" title={new Date(backup.requestedAt).toLocaleString()}>
        {timeAgo(backup.finishedAt ?? backup.requestedAt)}
        <span className="block text-xs text-muted-foreground">{backup.trigger === 'scheduled' ? 'Scheduled' : 'Made by hand'}</span>
      </TableCell>
      <TableCell className="whitespace-nowrap">{backup.sizeBytes == null ? '—' : formatBytes(backup.sizeBytes)}</TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant="outline" className={s.className}>{s.label}</Badge>
          {backup.status === 'ok' && backup.encrypted && <Badge variant="outline"><Lock className="size-3" aria-hidden="true" />Encrypted</Badge>}
          {backup.status === 'ok' && !backup.encrypted && <Badge variant="outline" className="border-warning/40 text-warning">Not encrypted</Badge>}
          {backup.status === 'ok' && backup.verified && <Badge variant="outline" className="border-success/40 text-success"><ShieldCheck className="size-3" aria-hidden="true" />Checked</Badge>}
        </div>
        {backup.error && <p className="mt-1 text-xs text-destructive">{backup.error}</p>}
        {backup.warning && <p className="mt-1 text-xs text-warning">{backup.warning}</p>}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          {backup.downloadable && <Button variant="ghost" size="sm" aria-label={`Download the backup from ${new Date(backup.requestedAt).toLocaleString()}`} onClick={() => onDownload(backup)}><Download className="size-4" aria-hidden="true" /></Button>}
          {(backup.status === 'ok' || backup.status === 'failed') && <Button variant="ghost" size="sm" aria-label={`Delete the backup from ${new Date(backup.requestedAt).toLocaleString()}`} onClick={() => onDelete(backup)}><Trash2 className="size-4" aria-hidden="true" /></Button>}
        </div>
      </TableCell>
    </TableRow>
  )
}

/** The list of backups (Shipdok's own, or the apps' volumes with the app named). */
export function BackupTable({ backups, showApp = false, onDownload, onDelete }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>{showApp && <TableHead>App</TableHead>}<TableHead>When</TableHead><TableHead>Size</TableHead><TableHead>State</TableHead><TableHead className="text-right">Actions</TableHead></TableRow>
        </TableHeader>
        <TableBody>{backups.map((b) => <Row key={b.id} backup={b} showApp={showApp} onDownload={onDownload} onDelete={onDelete} />)}</TableBody>
      </Table>
    </div>
  )
}

/** Asks before a backup file is deleted; `backup` is the one to delete, or null when closed. */
export function DeleteBackupDialog({ backup, onClose }) {
  const client = useQueryClient()
  const remove = useMutation({
    mutationFn: (b) => api(`/backups/${b.id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('Backup deleted'); client.invalidateQueries({ queryKey: ['backups'] }) },
    onError: (err) => toast.error(err.message),
    onSettled: onClose,
  })
  return (
    <AlertDialog open={backup !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this backup?</AlertDialogTitle>
          <AlertDialogDescription>The file is removed from this machine. If you have not downloaded it, it is gone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={(e) => { e.preventDefault(); remove.mutate(backup) }} disabled={remove.isPending}>{remove.isPending ? 'Deleting…' : 'Delete'}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
