import { useState } from 'react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { useBackups } from '@/lib/queries'
import { formatBytes, timeAgo } from '@/lib/format'
import { isAppBusy, isAppRestoring, keepChoices, restoreModeLabel, scheduleText, volumeBackups, volumesText } from '@/lib/backups'
import { NativeSelect } from '@/components/native-select'
import { LoadError } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { DownloadDialog, RestoreDialog } from '@/components/backup-dialogs'
import { BackupTable, DeleteBackupDialog } from '@/components/backup-table'

function AppRow({ app, busy, restoring, scheduleOff }) {
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: (change) => api(`/backups/volumes/${app.id}/settings`, { method: 'PUT', body: { enabled: app.enabled, stop: app.stop, keep: app.keep, ...change } }),
    onSuccess: (data) => { client.setQueryData(['backups'], data); toast.success(`Saved for ${app.name}`) },
    onError: (err) => toast.error(err.message),
  })
  const now = useMutation({
    mutationFn: () => api(`/backups/volumes/${app.id}`, { method: 'POST' }),
    onSuccess: () => { toast.success(`A backup of ${app.name}'s data has been asked for`); client.invalidateQueries({ queryKey: ['backups'] }) },
    onError: (err) => { toast.error(err.status === 409 && err.body?.code !== 'restore_running' ? 'A backup of this app is already being made' : err.message); client.invalidateQueries({ queryKey: ['backups'] }) },
  })
  const id = `vb-${app.id}`
  return (
    <li className="space-y-3 rounded-md border p-3" aria-label={app.name}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{app.name}</p>
          <p className="text-sm text-muted-foreground">
            {volumesText(app.volumeCount)}{app.sizeBytes != null && ` · ${formatBytes(app.sizeBytes)}`}
            {' · '}{app.lastBackupAt ? `last backup ${timeAgo(app.lastBackupAt)}` : 'never backed up'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => now.mutate()} disabled={busy || restoring || now.isPending}>{restoring ? 'Restoring…' : busy ? 'Backing up…' : 'Back up now'}</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex items-start gap-2">
          <Switch id={`${id}-schedule`} checked={app.enabled} disabled={save.isPending} onCheckedChange={(enabled) => save.mutate({ enabled })} />
          <div className="space-y-0.5">
            <Label htmlFor={`${id}-schedule`}>Include in the automatic backups</Label>
            {app.enabled && scheduleOff && <p className="text-xs text-warning">The schedule above is off, so nothing is made by itself.</p>}
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Switch id={`${id}-stop`} checked={app.stop} disabled={save.isPending} onCheckedChange={(stop) => save.mutate({ stop })} />
          <div className="space-y-0.5">
            <Label htmlFor={`${id}-stop`}>Stop the app while copying</Label>
            <p className="text-xs text-muted-foreground">A short downtime, but a database in a volume is copied consistently.</p>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-keep`}>Keep the newest</Label>
          <NativeSelect id={`${id}-keep`} value={String(app.keep)} disabled={save.isPending} onChange={(v) => save.mutate({ keep: Number(v) })}>
            {keepChoices(app.keep).map((n) => <option key={n} value={n}>{n}</option>)}
          </NativeSelect>
        </div>
      </div>
    </li>
  )
}

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
                <span className="font-medium">{r.appName}</span>
                <Badge variant="outline" className={s.className}>{s.label}</Badge>
                <span className="text-muted-foreground">{timeAgo(r.finishedAt ?? r.requestedAt)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                From the backup of {r.backupMadeAt ? new Date(r.backupMadeAt).toLocaleString() : 'an earlier time'} · {restoreModeLabel(r.mode)}
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

export default function VolumeBackupsCard() {
  const backups = useBackups()
  const [downloading, setDownloading] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [restoring, setRestoring] = useState(null)
  const d = backups.data
  const own = volumeBackups(d?.backups)
  const newest = own[0]
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Backups of your apps' data</CardTitle>
        <CardDescription>
          The persistent volumes of an app, copied into one file per app. By default the app keeps running while its files are copied (read-only), which is fine for files but can catch a
          database half-written: for those turn on "Stop the app while copying". Copies are made on this machine like the others, so download them to keep them elsewhere. They use the same
          passphrase as the backups of Shipdok, and the same schedule.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {backups.isError && <LoadError error={backups.error} title="Could not load the backups" onRetry={() => backups.refetch()} />}
        {d && (
          <>
            {(d.restores ?? [])[0]?.status === 'failed' && (
              <Alert variant="destructive" role="status" aria-label="Last restore failed">
                <AlertTitle>The last restore of {d.restores[0].appName}'s data failed</AlertTitle>
                <AlertDescription>{d.restores[0].error ?? 'No reason was recorded.'}</AlertDescription>
              </Alert>
            )}
            {newest?.status === 'failed' && (
              <Alert variant="destructive" role="status" aria-label="Last app backup failed">
                <AlertTitle>The last backup of {newest.appName ?? 'an app'}'s data failed</AlertTitle>
                <AlertDescription>{newest.error ?? 'No reason was recorded.'}</AlertDescription>
              </Alert>
            )}
            {(d.apps ?? []).length === 0
              ? <p className="text-sm text-muted-foreground">No app has persistent storage yet. Add a path in an app's Settings tab (Persistent storage) and it will be listed here.</p>
              : (
                <>
                  <ul className="space-y-3">{(d.apps ?? []).map((app) => <AppRow key={app.id} app={app} busy={isAppBusy(d.backups, app.id)} restoring={isAppRestoring(d.restores, app.id)} scheduleOff={d.schedule.frequency === 'off'} />)}</ul>
                  <p className="text-sm text-muted-foreground">Schedule: {scheduleText(d.schedule)}. Change it in the card above.</p>
                </>
              )}
            {own.length > 0 && (
              <BackupTable
                backups={own} showApp onDownload={setDownloading} onDelete={setDeleting} onRestore={setRestoring}
                restoreBlocked={(b) => isAppBusy(d.backups, b.appId) || isAppRestoring(d.restores, b.appId)}
              />
            )}
            {(d.restores ?? []).length > 0 && <Restores restores={d.restores} />}
          </>
        )}
      </CardContent>
      {downloading && <DownloadDialog backup={downloading} onClose={() => setDownloading(null)} />}
      {restoring && <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} />}
      <DeleteBackupDialog backup={deleting} onClose={() => setDeleting(null)} />
    </Card>
  )
}
