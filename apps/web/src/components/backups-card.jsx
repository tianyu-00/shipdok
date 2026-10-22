import { useEffect, useState } from 'react'
import { Download, KeyRound, Lock, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { useBackups } from '@/lib/queries'
import { formatBytes, timeAgo } from '@/lib/format'
import { FREQUENCIES, WEEKDAYS, isBusy, latestBackups, localHourText, scheduleText, utcHourText } from '@/lib/backups'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { LoadError } from '@/components/states'
import { DownloadDialog, PassphraseDialog } from '@/components/backup-dialogs'

const STATUS = {
  queued: { label: 'Waiting', className: 'border-info/40 bg-info/10 text-info' },
  running: { label: 'Making…', className: 'border-info/40 bg-info/10 text-info' },
  ok: { label: 'Done', className: 'border-success/40 bg-success/10 text-success' },
  failed: { label: 'Failed', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
}

function Schedule({ schedule, nextRunAt }) {
  const client = useQueryClient()
  const [f, setF] = useState({ ...schedule, keep: String(schedule.keep) })
  const [problem, setProblem] = useState(null)
  useEffect(() => { setF({ ...schedule, keep: String(schedule.keep) }); setProblem(null) }, [schedule.frequency, schedule.hour, schedule.weekday, schedule.keep])
  const save = useMutation({
    mutationFn: (body) => api('/backups/settings', { method: 'PUT', body }),
    onSuccess: (data) => { client.setQueryData(['backups'], data); toast.success('Backup schedule saved') },
    onError: (err) => toast.error(err.message),
  })
  const keep = /^\d+$/.test(f.keep.trim()) ? Number(f.keep) : null
  const changed = f.frequency !== schedule.frequency || f.hour !== schedule.hour || f.weekday !== schedule.weekday || keep !== schedule.keep
  const submit = (e) => {
    e.preventDefault()
    if (keep === null || keep < 1 || keep > 60) { setProblem('A whole number from 1 to 60'); return }
    setProblem(null)
    save.mutate({ frequency: f.frequency, hour: f.hour, weekday: f.weekday, keep })
  }
  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      <p className="text-sm font-medium">Automatic backups</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field id="backup-frequency" label="How often">
          <NativeSelect id="backup-frequency" value={f.frequency} onChange={(v) => setF({ ...f, frequency: v })}>
            {Object.entries(FREQUENCIES).map(([v, name]) => <option key={v} value={v}>{name}</option>)}
          </NativeSelect>
        </Field>
        {f.frequency === 'weekly' && (
          <Field id="backup-weekday" label="On">
            <NativeSelect id="backup-weekday" value={String(f.weekday)} onChange={(v) => setF({ ...f, weekday: Number(v) })}>
              {WEEKDAYS.map((name, i) => <option key={name} value={i}>{name}</option>)}
            </NativeSelect>
          </Field>
        )}
        {f.frequency !== 'off' && (
          <Field id="backup-hour" label="At (UTC)" hint={`${localHourText(f.hour)} on your clock today`}>
            <NativeSelect id="backup-hour" value={String(f.hour)} onChange={(v) => setF({ ...f, hour: Number(v) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{utcHourText(h)}</option>)}
            </NativeSelect>
          </Field>
        )}
        <Field id="backup-keep" label="Keep the newest" error={problem} hint="Older backups are deleted.">
          <Input id="backup-keep" inputMode="numeric" aria-invalid={problem ? true : undefined} value={f.keep} onChange={(e) => { setF({ ...f, keep: e.target.value }); setProblem(null) }} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={!changed || save.isPending}>{save.isPending ? 'Saving…' : 'Save schedule'}</Button>
        <p className="text-sm text-muted-foreground">
          {scheduleText(schedule)}
          {nextRunAt && `. Next: ${new Date(nextRunAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}
        </p>
      </div>
    </form>
  )
}

function Row({ backup, onDownload, onDelete }) {
  const s = STATUS[backup.status] ?? STATUS.failed
  return (
    <TableRow>
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

export default function BackupsCard() {
  const client = useQueryClient()
  const backups = useBackups()
  const [downloading, setDownloading] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [passphrase, setPassphrase] = useState(false)
  const now = useMutation({
    mutationFn: () => api('/backups', { method: 'POST' }),
    onSuccess: () => { toast.success('A backup has been asked for'); client.invalidateQueries({ queryKey: ['backups'] }) },
    onError: (err) => { toast.error(err.status === 409 ? 'A backup is already being made' : err.message); client.invalidateQueries({ queryKey: ['backups'] }) },
  })
  const remove = useMutation({
    mutationFn: (b) => api(`/backups/${b.id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('Backup deleted'); client.invalidateQueries({ queryKey: ['backups'] }) },
    onError: (err) => toast.error(err.message),
    onSettled: () => setDeleting(null),
  })

  const d = backups.data
  const busy = isBusy(d?.backups)
  const { good, newest } = latestBackups(d?.backups)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Backups of Shipdok</CardTitle>
        <CardDescription>
          One file holds the database and the key that opens its encrypted data (your variables and GitHub credentials). It does not hold your apps' own data volumes,
          and it is made on this machine: copy backups somewhere else with Download, because a backup on the same disk does not protect you from losing the disk.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {backups.isError && <LoadError error={backups.error} title="Could not load the backups" onRetry={() => backups.refetch()} />}
        {d && (
          <>
            {!d.persistent && (
              <Alert className="border-warning/50 text-warning" role="status" aria-label="Backups folder">
                <AlertTitle>The backups are not on a volume of their own</AlertTitle>
                <AlertDescription>They would be lost when the Shipdok container is replaced (an update). Update your compose.yaml from this release, which adds the backups volume, and restart.</AlertDescription>
              </Alert>
            )}
            {newest?.status === 'failed' && (
              <Alert variant="destructive" role="status" aria-label="Last backup failed">
                <AlertTitle>The last backup failed</AlertTitle>
                <AlertDescription>{newest.error ?? 'No reason was recorded.'}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                {good ? <>Last backup: <strong>{timeAgo(good.finishedAt)}</strong> ({formatBytes(good.sizeBytes ?? 0)})</> : <strong>No backup has been made yet</strong>}
                {d.totalBytes > 0 && <span className="text-muted-foreground"> · {formatBytes(d.totalBytes)} in all</span>}
              </p>
              <Button onClick={() => now.mutate()} disabled={busy || now.isPending}>{busy ? 'Backing up…' : 'Back up now'}</Button>
            </div>

            {d.backups.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Size</TableHead><TableHead>State</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                  <TableBody>{d.backups.map((b) => <Row key={b.id} backup={b} onDownload={setDownloading} onDelete={setDeleting} />)}</TableBody>
                </Table>
              </div>
            )}

            <Schedule schedule={d.schedule} nextRunAt={d.nextRunAt} />

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
              <p className="flex items-center gap-2 text-sm"><KeyRound className="size-4" aria-hidden="true" />{d.encryption.enabled ? 'New backups are encrypted with your passphrase' : 'New backups are not encrypted'}</p>
              <Button variant="outline" size="sm" onClick={() => setPassphrase(true)}>{d.encryption.enabled ? 'Change or remove the passphrase' : 'Set a passphrase'}</Button>
            </div>
          </>
        )}
      </CardContent>
      {downloading && <DownloadDialog backup={downloading} onClose={() => setDownloading(null)} />}
      {passphrase && <PassphraseDialog enabled={d?.encryption.enabled} onClose={() => setPassphrase(false)} />}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this backup?</AlertDialogTitle>
            <AlertDialogDescription>The file is removed from this machine. If you have not downloaded it, it is gone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); remove.mutate(deleting) }} disabled={remove.isPending}>{remove.isPending ? 'Deleting…' : 'Delete'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
