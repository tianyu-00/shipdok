import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { useBackups } from '@/lib/queries'
import { formatBytes, timeAgo } from '@/lib/format'
import { FREQUENCIES, WEEKDAYS, isAppBusy, isAppRestoring, keepChoices, localHourText, parseRestoreKeep, utcHourText, volumesText } from '@/lib/backups'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/field'
import { Select } from '@/components/select'
import { LoadError } from '@/components/states'
import VolumeBackupHistory from '@/components/volume-backup-history'

/** How many finished restores stay in the app's history: a whole number from 1; empty keeps every restore. Saved when the field is left or Enter is pressed. */
function RestoreKeepField({ id, value, pending, onSave }) {
  const shown = value == null ? '' : String(value)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const parsed = parseRestoreKeep(text)
  const commit = () => { if (parsed !== undefined && parsed !== (value ?? null)) onSave(parsed) }
  return (
    <Field id={id} label="Remember this many restores" error={parsed === undefined ? 'A whole number from 1, or empty for all' : undefined}
      hint="Leave empty to keep every restore. Older ones are removed from the list.">
      <Input id={id} inputMode="numeric" placeholder="All" value={text} disabled={pending} aria-invalid={parsed === undefined ? true : undefined}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }} />
    </Field>
  )
}

/**
 * The Settings tab's section for the data of ONE app: how often its persistent volumes are backed up by themselves, whether it is stopped while they are
 * copied, how many backups to keep, Back up now, and this app's own backups and restores. Only for an app that has mounted persistent storage.
 */
export default function AppVolumeBackups({ app: shown }) {
  const client = useQueryClient()
  const backups = useBackups()
  const d = backups.data
  const app = (d?.apps ?? []).find((a) => a.id === shown.id)
  const save = useMutation({
    mutationFn: (change) => api(`/backups/volumes/${shown.id}/settings`, { method: 'PUT', body: { ...app.schedule, stop: app.stop, keep: app.keep, ...change } }),
    onSuccess: (data) => { client.setQueryData(['backups'], data); toast.success('Saved') },
    onError: (err) => toast.error(err.message),
  })
  const now = useMutation({
    mutationFn: () => api(`/backups/volumes/${shown.id}`, { method: 'POST' }),
    onSuccess: () => { toast.success('A backup of this app\'s data has been asked for'); client.invalidateQueries({ queryKey: ['backups'] }) },
    onError: (err) => { toast.error(err.status === 409 && err.body?.code !== 'restore_running' ? 'A backup of this app is already being made' : err.message); client.invalidateQueries({ queryKey: ['backups'] }) },
  })
  if (backups.isError) return <LoadError error={backups.error} title="Could not load the backups" onRetry={() => backups.refetch()} />
  if (!app) return null // no mounted persistent storage: nothing to back up
  const busy = isAppBusy(d.backups, app.id)
  const restoring = isAppRestoring(d.restores, app.id)
  const s = app.schedule
  const id = `vb-${app.id}`
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Backups of this app's data</CardTitle>
        <CardDescription>
          The files in this app's persistent storage, copied into one file (read-only: the app keeps running unless you choose to stop it while copying). They use the same passphrase as the
          backups of Shipdok, are kept on this machine (download them to keep them elsewhere), and can be restored from the list below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {volumesText(app.volumeCount)}{app.sizeBytes != null && ` · ${formatBytes(app.sizeBytes)}`}
            {' · '}{app.lastBackupAt ? `last backup ${timeAgo(app.lastBackupAt)}` : 'never backed up'}
          </p>
          <Button variant="outline" size="sm" onClick={() => now.mutate()} disabled={busy || restoring || now.isPending}>{restoring ? 'Restoring…' : busy ? 'Backing up…' : 'Back up now'}</Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field id={`${id}-frequency`} label="Automatic backups">
            <Select id={`${id}-frequency`} value={s.frequency} disabled={save.isPending} onChange={(v) => save.mutate({ frequency: v })}>
              {Object.entries(FREQUENCIES).map(([v, name]) => <option key={v} value={v}>{v === 'off' ? 'Off' : name}</option>)}
            </Select>
          </Field>
          {s.frequency === 'weekly' && (
            <Field id={`${id}-weekday`} label="On">
              <Select id={`${id}-weekday`} value={String(s.weekday)} disabled={save.isPending} onChange={(v) => save.mutate({ weekday: Number(v) })}>
                {WEEKDAYS.map((name, i) => <option key={name} value={i}>{name}</option>)}
              </Select>
            </Field>
          )}
          {s.frequency !== 'off' && (
            <Field id={`${id}-hour`} label="At (UTC)" hint={`${localHourText(s.hour)} on your clock today`}>
              <Select id={`${id}-hour`} value={String(s.hour)} disabled={save.isPending} onChange={(v) => save.mutate({ hour: Number(v) })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{utcHourText(h)}</option>)}
              </Select>
            </Field>
          )}
          <Field id={`${id}-keep`} label="Keep the newest" hint="Older backups of this app are deleted.">
            <Select id={`${id}-keep`} value={String(app.keep)} disabled={save.isPending} onChange={(v) => save.mutate({ keep: Number(v) })}>
              {keepChoices(app.keep).map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </Field>
          <RestoreKeepField id={`${id}-restore-keep`} value={app.restoreKeep} pending={save.isPending} onSave={(restoreKeep) => save.mutate({ restoreKeep })} />
        </div>
        {app.nextRunAt && <p className="text-sm text-muted-foreground">Next automatic backup: {new Date(app.nextRunAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</p>}

        <div className="flex items-start gap-2">
          <Switch id={`${id}-stop`} checked={app.stop} disabled={save.isPending} onCheckedChange={(stop) => save.mutate({ stop })} />
          <div className="space-y-0.5">
            <Label htmlFor={`${id}-stop`}>Stop the app while copying</Label>
            <p className="text-xs text-muted-foreground">A short downtime, but a database in a volume is copied consistently.</p>
          </div>
        </div>

        <VolumeBackupHistory data={d} appId={app.id} />
      </CardContent>
    </Card>
  )
}
