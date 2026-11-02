// Backups of Shipdok itself: small pure helpers for the Storage page's Backups card, and the download (a file, not JSON, so it cannot go through `api`).
import { ApiError } from '@/lib/api'

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const FREQUENCIES = { off: 'Off', daily: 'Every day', weekly: 'Every week' }

const pad = (n) => String(n).padStart(2, '0')

/** "03:00 UTC" */
export const utcHourText = (hour) => `${pad(hour)}:00 UTC`

/** What an hour in UTC is on this computer's clock today, for example "14:00". The schedule is in UTC (the server's clock); people think in their own. */
export function localHourText(hour, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour))
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** One line saying what the schedule is. */
export function scheduleText(schedule) {
  if (schedule.frequency === 'off') return 'No automatic backups'
  const at = `${utcHourText(schedule.hour)} (${localHourText(schedule.hour)} on your clock today)`
  const when = schedule.frequency === 'weekly' ? `Every ${WEEKDAYS[schedule.weekday]} at ${at}` : `Every day at ${at}`
  return `${when}, keeping the newest ${schedule.keep}`
}

/** Backups of Shipdok itself (a backup without a kind is one) and the backups of apps' volumes. */
export const platformBackups = (backups) => (backups ?? []).filter((b) => b.kind !== 'volumes')
export const volumeBackups = (backups) => (backups ?? []).filter((b) => b.kind === 'volumes')

/**
 * Volume backups that no app's Settings tab lists any more: their app is gone (no app id, which is never among `apps`) or it has no mounted storage now (it is not among `apps`).
 * Only finished ones (done or failed): one that is still being made belongs to an app that is there.
 */
export function keptBackups(data) {
  const present = new Set((data?.apps ?? []).map((a) => a.id))
  return volumeBackups(data?.backups).filter((b) => (b.status === 'ok' || b.status === 'failed') && !present.has(b.appId))
}

/** Is a backup waiting or being made? */
export const isBusy = (backups) => (backups ?? []).some((b) => b.status === 'queued' || b.status === 'running')

/** Is a backup of THIS app's volumes waiting or being made? */
export const isAppBusy = (backups, appId) => isBusy(volumeBackups(backups).filter((b) => b.appId === appId))

/** Is a restore of THIS app waiting or running? (Then no backup or restore of it can be asked for.) */
export const isAppRestoring = (restores, appId) => (restores ?? []).some((r) => r.appId === appId && (r.status === 'queued' || r.status === 'running'))

/** The ways to restore, in the order offered (the first is the default). */
export const RESTORE_MODES = [
  { value: 'replace', label: 'Replace', hint: 'The volume ends up exactly as the backup was. Files that are not in the backup are removed.' },
  { value: 'add', label: 'Add over', hint: 'The backup\'s files are written over the current ones. Files that are only in the volume now stay.' },
  { value: 'empty', label: 'Only into empty volumes', hint: 'Refused if a volume holds anything. Nothing is overwritten.' },
]
export const restoreModeLabel = (mode) => RESTORE_MODES.find((m) => m.value === mode)?.label ?? mode

/** How many volume backups an app may keep: the choices offered (the app's own number is added when it is not one of them). */
export const KEEP_CHOICES = [1, 2, 3, 5, 7, 10, 14, 30, 60]
export const keepChoices = (current) => (KEEP_CHOICES.includes(current) ? KEEP_CHOICES : [...KEEP_CHOICES, current].sort((a, b) => a - b))

/** "2 volumes" */
export const volumesText = (n) => `${n} volume${n === 1 ? '' : 's'}`

/** The newest backup that worked, and the newest of all (which may have failed). */
export function latestBackups(backups) {
  const list = backups ?? []
  return { good: list.find((b) => b.status === 'ok') ?? null, newest: list[0] ?? null }
}

/** The file name the server gave, from the Content-Disposition header (else a plain one). */
export function filenameFrom(header, fallback = 'shipdok-backup.tar') {
  const m = /filename="([^"\\/\r\n]+)"/.exec(header ?? '')
  return m ? m[1] : fallback
}

/** Asks for a file with the password and hands it to the browser as a download. Throws an ApiError that says why when the server refuses. */
export async function downloadBackup(id, password) {
  let res
  try {
    res = await fetch(`/api/backups/${id}/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, 'Cannot reach the Shipdok API. Is it running?')
  }
  if (!res.ok) {
    let data = null
    try { data = await res.json() } catch { /* not JSON */ }
    throw new ApiError(res.status, data?.error ?? `The download failed (${res.status})`, data)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filenameFrom(res.headers.get('Content-Disposition'))
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}
