import { useEffect, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { useBackups } from '@/lib/queries'
import { formatBytes, timeAgo } from '@/lib/format'
import { FREQUENCIES, WEEKDAYS, isBusy, latestBackups, localHourText, platformBackups, scheduleText, utcHourText } from '@/lib/backups'
import { Field } from '@/components/field'
import { Select } from '@/components/select'
import { LoadError } from '@/components/states'
import { DownloadDialog, PassphraseDialog } from '@/components/backup-dialogs'
import { BackupTable, DeleteBackupDialog } from '@/components/backup-table'

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
          <Select id="backup-frequency" value={f.frequency} onChange={(v) => setF({ ...f, frequency: v })}>
            {Object.entries(FREQUENCIES).map(([v, name]) => <option key={v} value={v}>{name}</option>)}
          </Select>
        </Field>
        {f.frequency === 'weekly' && (
          <Field id="backup-weekday" label="On">
            <Select id="backup-weekday" value={String(f.weekday)} onChange={(v) => setF({ ...f, weekday: Number(v) })}>
              {WEEKDAYS.map((name, i) => <option key={name} value={i}>{name}</option>)}
            </Select>
          </Field>
        )}
        {f.frequency !== 'off' && (
          <Field id="backup-hour" label="At (UTC)" hint={`${localHourText(f.hour)} on your clock today`}>
            <Select id="backup-hour" value={String(f.hour)} onChange={(v) => setF({ ...f, hour: Number(v) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{utcHourText(h)}</option>)}
            </Select>
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

  const d = backups.data
  const own = platformBackups(d?.backups)
  const busy = isBusy(own)
  const { good, newest } = latestBackups(own)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Backups of Shipdok</CardTitle>
        <CardDescription>
          One file holds the database and the key that opens its encrypted data (your variables and GitHub credentials). Your apps' own data volumes are backed up separately, in each app's Settings tab.
          Backups are made on this machine: copy backups somewhere else with Download, because a backup on the same disk does not protect you from losing the disk.
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
                {own.some((b) => b.status === 'ok') && <span className="text-muted-foreground"> · {formatBytes(own.filter((b) => b.status === 'ok').reduce((n, b) => n + (b.sizeBytes ?? 0), 0))} in all</span>}
              </p>
              <Button onClick={() => now.mutate()} disabled={busy || now.isPending}>{busy ? 'Backing up…' : 'Back up now'}</Button>
            </div>

            {own.length > 0 && <BackupTable backups={own} onDownload={setDownloading} onDelete={setDeleting} />}

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
      <DeleteBackupDialog backup={deleting} onClose={() => setDeleting(null)} />
    </Card>
  )
}
