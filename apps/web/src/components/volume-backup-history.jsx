import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { timeAgo } from '@/lib/format'
import { isAppBusy, isAppRestoring, restoreModeLabel, volumeBackups, volumesText } from '@/lib/backups'
import { DownloadDialog, RestoreDialog } from '@/components/backup-dialogs'
import { BackupTable, DeleteBackupDialog } from '@/components/backup-table'

const RESTORE_STATUS = {
  queued: { label: 'Waiting', className: 'border-info/40 bg-info/10 text-info' },
  running: { label: 'Restoring…', className: 'border-info/40 bg-info/10 text-info' },
  ok: { label: 'Done', className: 'border-success/40 bg-success/10 text-success' },
  failed: { label: 'Failed', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
}

function Restores({ restores }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Restores</p>
      <ul className="space-y-2">
        {restores.map((r) => {
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
  return (
    <>
      {newestRestore?.status === 'failed' && (
        <Alert variant="destructive" role="status" aria-label="Last restore failed">
          <AlertTitle>The last restore of this app's data failed</AlertTitle>
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
      {restores.length > 0 && <Restores restores={restores} />}
      {downloading && <DownloadDialog backup={downloading} onClose={() => setDownloading(null)} />}
      {restoring && <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} />}
      <DeleteBackupDialog backup={deleting} onClose={() => setDeleting(null)} />
    </>
  )
}
