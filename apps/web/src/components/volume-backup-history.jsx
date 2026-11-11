import { useState } from 'react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { timeAgo } from '@/lib/format'
import { isAppBusy, isAppRestoring, restoreModeLabel, volumeBackups, volumesText } from '@/lib/backups'
import { pageOf, savedPageSize, savePageSize } from '@/lib/paging'
import { Pager } from '@/components/pager'
import { DownloadDialog, RestoreDialog } from '@/components/backup-dialogs'
import { BackupTable, DeleteBackupDialog } from '@/components/backup-table'

const RESTORE_STATUS = {
  queued: { label: 'Waiting', className: 'border-info/40 bg-info/10 text-info' },
  running: { label: 'Restoring…', className: 'border-info/40 bg-info/10 text-info' },
  ok: { label: 'Done', className: 'border-success/40 bg-success/10 text-success' },
  failed: { label: 'Failed', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
}

/** Empties the finished restores of the app's history (a restore that is waiting or running stays; the backups are not touched). */
function ClearRestores({ appId, finished }) {
  const client = useQueryClient()
  const [asking, setAsking] = useState(false)
  const clear = useMutation({
    mutationFn: () => api(`/backups/volumes/${appId}/restores`, { method: 'DELETE' }),
    onSuccess: (data) => { client.setQueryData(['backups'], data); toast.success(`${data.cleared} restore${data.cleared === 1 ? '' : 's'} cleared from the history`) },
    onError: (err) => toast.error(err.message),
    onSettled: () => setAsking(false),
  })
  return (
    <>
      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setAsking(true)}>Clear</Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the restore history of this app?</AlertDialogTitle>
            <AlertDialogDescription>
              The {finished} finished restore{finished === 1 ? '' : 's'} listed here will be removed from the list. Only the history goes: the app's files and its backups are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); clear.mutate() }}>Clear the history</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// The restores list starts at 5 a page (the administrator's decision) and remembers its own choice; the other paged lists start at 10.
const RESTORE_SIZE_KEY = 'shipdok.restorePageSize'
const RESTORE_SIZE_DEFAULT = 5

function Restores({ restores, appId }) {
  const [size, setSize] = useState(() => savedPageSize(RESTORE_SIZE_KEY, RESTORE_SIZE_DEFAULT))
  const [at, setAt] = useState(0)
  const { items, page, pages } = pageOf(restores, at, size)
  const finished = restores.filter((r) => r.status === 'ok' || r.status === 'failed').length
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Restores <span className="font-normal text-muted-foreground">({restores.length})</span></p>
        {finished > 0 && <ClearRestores appId={appId} finished={finished} />}
      </div>
      <ul className="space-y-2">
        {items.map((r) => {
          const s = RESTORE_STATUS[r.status] ?? RESTORE_STATUS.failed
          return (
            <li key={r.id} className="rounded-md border p-3 text-sm" aria-label={`Restore of ${r.appName}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={s.className}>{s.label}</Badge>
                <span className="text-muted-foreground">{timeAgo(r.finishedAt ?? r.requestedAt)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {r.reclaim ? `Reclaimed from the backup of ${r.backupAppName ?? 'another app'}, made ` : 'From the backup of '}{r.backupMadeAt ? new Date(r.backupMadeAt).toLocaleString() : 'an earlier time'} · {restoreModeLabel(r.mode)}
                {r.safetyBackup ? ' · backup of the current data first' : ' · no backup of the current data'}
                {r.status === 'ok' && r.volumeCount != null && ` · ${volumesText(r.volumeCount)} restored`}
              </p>
              {r.error && <p className="mt-1 text-xs text-destructive">{r.error}</p>}
              {r.warning && <p className="mt-1 text-xs text-warning">{r.warning}</p>}
            </li>
          )
        })}
      </ul>
      <Pager id={`restore-page-size-${appId}`} count={restores.length} page={page} pages={pages} size={size} onPage={setAt} onSize={(n) => { setSize(n); savePageSize(RESTORE_SIZE_KEY, n); setAt(0) }} />
    </div>
  )
}

/**
 * The volume backups and restores of ONE app (appId), newest first, with Download, Restore and Delete. `data` is the answer of GET /api/backups.
 */
export default function VolumeBackupHistory({ data, appId }) {
  const [downloading, setDownloading] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [restoring, setRestoring] = useState(null)
  const mine = (x) => x.appId === appId
  const backups = volumeBackups(data?.backups).filter(mine)
  const restores = (data?.restores ?? []).filter(mine)
  const newest = backups[0]
  const newestRestore = restores[0]
  const client = useQueryClient()
  const dismiss = useMutation({
    mutationFn: (id) => api(`/backups/restores/${id}/dismiss`, { method: 'POST' }),
    onSuccess: (data) => client.setQueryData(['backups'], data),
    onError: (err) => toast.error(err.message),
  })
  return (
    <>
      {newestRestore?.status === 'failed' && !newestRestore.dismissed && (
        <Alert variant="destructive" role="status" aria-label="Last restore failed">
          <AlertTitle className="flex items-start justify-between gap-2">
            <span>The last restore of this app's data failed</span>
            <Button variant="ghost" size="sm" className="-my-1 h-7 shrink-0" disabled={dismiss.isPending} onClick={() => dismiss.mutate(newestRestore.id)}>Dismiss</Button>
          </AlertTitle>
          <AlertDescription>{newestRestore.error ?? 'No reason was recorded.'}</AlertDescription>
        </Alert>
      )}
      {newest?.status === 'failed' && (
        <Alert variant="destructive" role="status" aria-label="Last app backup failed">
          <AlertTitle>The last backup of this app's data failed</AlertTitle>
          <AlertDescription>{newest.error ?? 'No reason was recorded.'}</AlertDescription>
        </Alert>
      )}
      {backups.length > 0 && (
        <BackupTable
          backups={backups} onDownload={setDownloading} onDelete={setDeleting} onRestore={setRestoring}
          restoreBlocked={(b) => isAppBusy(data.backups, b.appId) || isAppRestoring(data.restores, b.appId)}
        />
      )}
      {restores.length > 0 && <Restores restores={restores} appId={appId} />}
      {downloading && <DownloadDialog backup={downloading} onClose={() => setDownloading(null)} />}
      {restoring && <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} />}
      <DeleteBackupDialog backup={deleting} onClose={() => setDeleting(null)} />
    </>
  )
}
