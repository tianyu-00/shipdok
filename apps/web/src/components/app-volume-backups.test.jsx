// The Settings tab's section for one app's data backups: its schedule, stop switch, keep, Back up now, and its own list of backups and restores.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AppVolumeBackups from './app-volume-backups'
import BackupsCard from './backups-card'
import { mockApi, answer, renderWithProviders, pick, listedValues } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString()
const volumeBackup = (over = {}) => ({
  id: 'v1', kind: 'volumes', appId: 'a1', appName: 'Blog', volumeCount: 2, status: 'ok', trigger: 'scheduled', requestedAt: ago(61), startedAt: ago(61), finishedAt: ago(60),
  sizeBytes: 3 * 1024 * 1024, encrypted: true, verified: true, version: '0.1.19', warning: null, error: null, downloadable: true, restorable: true, ...over,
})
const platform = (over = {}) => ({
  id: 'p1', kind: 'platform', appId: null, appName: null, volumeCount: null, status: 'ok', trigger: 'manual', requestedAt: ago(30), startedAt: ago(30), finishedAt: ago(29),
  sizeBytes: 1024, encrypted: false, verified: true, version: '0.1.19', warning: null, error: null, downloadable: true, restorable: false, ...over,
})
const OFF = { frequency: 'off', hour: 3, weekday: 1 }
const blog = (over = {}) => ({ id: 'a1', name: 'Blog', volumeCount: 2, sizeBytes: 5 * 1024 * 1024, lastBackupAt: ago(60), schedule: OFF, nextRunAt: null, stop: false, keep: 2, ...over })
const restore = (over = {}) => ({
  id: 'r1', backupId: 'v1', appId: 'a1', appName: 'Blog', backupMadeAt: ago(60), mode: 'replace', safetyBackup: true, safetyBackupId: null, status: 'ok', requestedAt: ago(10), startedAt: ago(10), finishedAt: ago(9),
  volumeCount: 2, warning: null, error: null, ...over,
})
const overview = (over = {}) => ({
  backups: [volumeBackup()], restores: [], totalBytes: 0, schedule: { frequency: 'daily', hour: 3, weekday: 1, keep: 7 }, nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
  apps: [blog()], encryption: { enabled: true }, persistent: true, ...over,
})
const section = (data = overview(), extra = {}, appId = 'a1') => { const api = mockApi({ 'GET /api/backups': data, ...extra }); renderWithProviders(<AppVolumeBackups app={{ id: appId }} />); return api }
const put = (api) => api.called('PUT', '/api/backups/volumes/a1/settings')

describe('what it shows', () => {
  test('the volumes, their size, the last backup, and how it is set', async () => {
    section()
    expect(await screen.findByText('Backups of this app\'s data')).toBeInTheDocument()
    expect(screen.getByText('2 volumes · 5.0 MB · last backup 1 h ago')).toBeInTheDocument()
    expect(screen.getByLabelText('Automatic backups')).toHaveChosen('off')
    expect(screen.getByRole('switch', { name: 'Stop the app while copying' })).not.toBeChecked()
    expect(screen.getByLabelText('Keep the newest')).toHaveChosen('2')
    expect(screen.queryByLabelText('At (UTC)')).toBeNull()
    expect(screen.queryByLabelText('On')).toBeNull()
    expect(screen.queryByText(/Next automatic backup/)).toBeNull()
  })
  test('shows nothing for an app that has no mounted storage', async () => {
    const api = mockApi({ 'GET /api/backups': overview({ apps: [blog({ id: 'other' })] }) })
    const { container } = renderWithProviders(<AppVolumeBackups app={{ id: 'a1' }} />)
    await waitFor(() => expect(api.called('GET', '/api/backups')).toHaveLength(1))
    await waitFor(() => expect(container.querySelectorAll('p, button, [data-slot=card], h1, h2, h3')).toHaveLength(0))
  })
  test('a daily schedule shows the hour (in UTC, with the local time) and the next run; weekly adds the day', async () => {
    section(overview({ apps: [blog({ schedule: { frequency: 'daily', hour: 14, weekday: 1 }, nextRunAt: new Date(Date.now() + 3600_000).toISOString() })] }))
    expect(await screen.findByLabelText('At (UTC)')).toHaveChosen('14')
    expect(screen.getByText(/^\d{2}:\d{2} on your clock today$/)).toBeInTheDocument()
    expect(screen.getByText(/Next automatic backup:/)).toBeInTheDocument()
    expect(screen.queryByLabelText('On')).toBeNull()
    document.body.innerHTML = ''
    section(overview({ apps: [blog({ schedule: { frequency: 'weekly', hour: 14, weekday: 5 } })] }))
    expect(await screen.findByLabelText('On')).toHaveChosen('5')
  })
  test('an app that was never backed up says so, and an unmeasured size is left out (never a made-up number)', async () => {
    section(overview({ apps: [blog({ lastBackupAt: null, sizeBytes: null, volumeCount: 1 })], backups: [] }))
    expect(await screen.findByText('1 volume · never backed up')).toBeInTheDocument()
  })
  test('a number to keep that is not among the usual choices is still shown', async () => {
    section(overview({ apps: [blog({ keep: 4 })] }))
    expect(await screen.findByLabelText('Keep the newest')).toHaveChosen('4')
    expect(await listedValues(screen.getByLabelText('Keep the newest'))).toEqual(['1', '2', '3', '4', '5', '7', '10', '14', '30', '60'])
  })
  test('says plainly when the list cannot be loaded', async () => {
    mockApi({ 'GET /api/backups': answer(500, { error: 'boom' }) })
    renderWithProviders(<AppVolumeBackups app={{ id: 'a1' }} />)
    expect(await screen.findByText('Could not load the backups')).toBeInTheDocument()
  })
})

describe('changing how it is backed up', () => {
  test('choosing a frequency sends the whole setting with only that changed, and says so', async () => {
    const api = section(overview({ apps: [blog({ stop: true, keep: 5 })] }), { 'PUT /api/backups/volumes/a1/settings': overview({ apps: [blog({ schedule: { frequency: 'daily', hour: 3, weekday: 1 }, stop: true, keep: 5 })] }) })
    await pick(await screen.findByLabelText('Automatic backups'), 'daily')
    await waitFor(() => expect(put(api)).toHaveLength(1))
    expect(put(api)[0].body).toEqual({ frequency: 'daily', hour: 3, weekday: 1, stop: true, keep: 5 })
    expect(toasts.success).toHaveBeenCalledWith('Saved')
    expect(await screen.findByLabelText('At (UTC)')).toBeInTheDocument()
  })
  test('the hour, the weekday, the stop switch and the number to keep each change only themselves', async () => {
    const sched = { frequency: 'weekly', hour: 3, weekday: 1 }
    const api = section(overview({ apps: [blog({ schedule: sched })] }), { 'PUT /api/backups/volumes/a1/settings': overview({ apps: [blog({ schedule: { frequency: 'weekly', hour: 20, weekday: 6 }, stop: true, keep: 14 })] }) })
    await pick(await screen.findByLabelText('At (UTC)'), '20')
    await waitFor(() => expect(put(api)).toHaveLength(1))
    expect(put(api)[0].body).toEqual({ frequency: 'weekly', hour: 20, weekday: 1, stop: false, keep: 2 })
    await pick(await screen.findByLabelText('On'), '6')
    await waitFor(() => expect(put(api)).toHaveLength(2))
    expect(put(api)[1].body).toEqual({ frequency: 'weekly', hour: 20, weekday: 6, stop: true, keep: 14 }) // (the answer of the first save is what is shown now)
  })
  test('the stop switch and keep', async () => {
    const api = section(overview(), { 'PUT /api/backups/volumes/a1/settings': overview({ apps: [blog({ stop: true })] }) })
    await userEvent.click(await screen.findByRole('switch', { name: 'Stop the app while copying' }))
    await waitFor(() => expect(put(api)).toHaveLength(1))
    expect(put(api)[0].body).toEqual({ ...OFF, stop: true, keep: 2 })
    await pick(screen.getByLabelText('Keep the newest'), '14')
    await waitFor(() => expect(put(api)).toHaveLength(2))
    expect(put(api)[1].body).toEqual({ ...OFF, stop: true, keep: 14 })
  })
  test('a refusal shows the server\'s reason', async () => {
    section(overview(), { 'PUT /api/backups/volumes/a1/settings': answer(404, { error: 'App not found' }) })
    await userEvent.click(await screen.findByRole('switch', { name: 'Stop the app while copying' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('App not found'))
  })
})

describe('backing up now', () => {
  test('asks for this app\'s volumes and says so', async () => {
    const api = section(overview(), { 'POST /api/backups/volumes/a1': answer(202, { id: 'n' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(api.called('POST', '/api/backups/volumes/a1')).toHaveLength(1))
    expect(toasts.success).toHaveBeenCalledWith('A backup of this app\'s data has been asked for')
  })
  test('is switched off while a backup of this app is waiting or running, but not for another app\'s, nor a Shipdok backup', async () => {
    section(overview({ backups: [volumeBackup({ id: 'q', status: 'running', downloadable: false, restorable: false, sizeBytes: null, finishedAt: null })] }))
    expect(await screen.findByRole('button', { name: 'Backing up…' })).toBeDisabled()
    document.body.innerHTML = ''
    section(overview({ backups: [volumeBackup({ id: 'q', appId: 'a2', status: 'running', downloadable: false, restorable: false, finishedAt: null }), platform({ status: 'running', downloadable: false, finishedAt: null })] }))
    expect(await screen.findByRole('button', { name: 'Back up now' })).toBeEnabled()
  })
  test('a 409 is said gently, one because of a restore is said as it is, another failure shows its message', async () => {
    section(overview(), { 'POST /api/backups/volumes/a1': answer(409, { error: 'x', code: 'already_running' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('A backup of this app is already being made'))
  })
  test('a 409 because a restore is running is not reported as "a backup is already being made"', async () => {
    section(overview(), { 'POST /api/backups/volumes/a1': answer(409, { error: 'A restore of this app is waiting or running', code: 'restore_running' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('A restore of this app is waiting or running'))
  })
})

describe('this app\'s list', () => {
  test('shows only this app\'s backups, without an App column, with the volumes and how each went', async () => {
    section(overview({ backups: [volumeBackup(), volumeBackup({ id: 'v2', appId: 'a2', appName: 'Shop', volumeCount: 7 }), platform()] }))
    const row = await screen.findByRole('row', { name: /Scheduled/ })
    expect(within(row).getByText('Encrypted')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(2)
    expect(screen.queryByRole('columnheader', { name: 'App' })).toBeNull()
    expect(screen.queryByText('7 volumes')).toBeNull()
  })
  test('a failed one shows why, in the row and in a notice above, and has no download', async () => {
    section(overview({ backups: [volumeBackup({ id: 'f', status: 'failed', error: 'Not enough free disk space: …', downloadable: false, restorable: false, sizeBytes: null })] }))
    const notice = await screen.findByRole('status', { name: 'Last app backup failed' })
    expect(notice).toHaveTextContent('The last backup of this app\'s data failed')
    expect(notice).toHaveTextContent('Not enough free disk space')
    expect(screen.queryByRole('button', { name: /Download the backup/ })).toBeNull()
  })
  test('no failure notice when the newest worked, and a failed backup of ANOTHER app is not shown at all', async () => {
    section(overview({ backups: [volumeBackup(), volumeBackup({ id: 'f', status: 'failed', error: 'old', downloadable: false, restorable: false }), volumeBackup({ id: 'o', appId: 'a2', appName: 'Shop', status: 'failed', error: 'theirs', restorable: false })] }))
    await screen.findAllByRole('row')
    expect(screen.queryByRole('status', { name: 'Last app backup failed' })).toBeNull()
    expect(screen.queryByText('theirs')).toBeNull()
  })
  test('a warning (the app did not start again) is shown, and a backup made before a restore carries a badge saying so', async () => {
    section(overview({ backups: [volumeBackup({ warning: 'The app could not be started again after the copy: port in use', trigger: 'before_restore' })] }))
    expect(await screen.findByText(/could not be started again/)).toBeInTheDocument()
    const row = screen.getByRole('row', { name: /Safety copy before a restore/ })
    expect(within(row).getByText('Safety copy before a restore')).toBeInTheDocument()
    expect(within(row).getByText('Automatic')).toBeInTheDocument()
  })
  test('download asks for the password and names the app\'s data, not "every secret"', async () => {
    section()
    await userEvent.click(await screen.findByRole('button', { name: /Download the backup/ }))
    expect(await screen.findByText(/all the data in the volumes of Blog/)).toBeInTheDocument()
    expect(screen.queryByText(/every secret Shipdok has/)).toBeNull()
  })
  test('delete asks first, then deletes that one', async () => {
    const api = section(overview(), { 'DELETE /api/backups/v1': null })
    await userEvent.click(await screen.findByRole('button', { name: /Delete the backup/ }))
    expect(api.called('DELETE', '/api/backups/v1')).toHaveLength(0)
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.called('DELETE', '/api/backups/v1')).toHaveLength(1))
  })
})

describe('the safety copy made before a restore', () => {
  test('is marked with a badge, so it is not mistaken for the others; the others have none', async () => {
    section(overview({ backups: [volumeBackup({ id: 's', trigger: 'before_restore' }), volumeBackup({ id: 'm', trigger: 'manual' }), volumeBackup({ id: 'c', trigger: 'scheduled' })] }))
    await screen.findAllByRole('row')
    expect(screen.getAllByText('Safety copy before a restore')).toHaveLength(1)
    expect(screen.getByText('Made by hand')).toBeInTheDocument()
    expect(screen.getByText('Scheduled')).toBeInTheDocument()
  })
})

describe('a reclaim in the restores list', () => {
  test('says whose backup it used, so it is not mistaken for a restore of the app\'s own data', async () => {
    section(overview({ restores: [restore({ reclaim: true, backupAppName: 'Old blog', warning: 'Added the storage path /data to the app: deploy it to mount it' }), restore({ id: 'r2', reclaim: false })] }))
    const items = await screen.findAllByRole('listitem', { name: 'Restore of Blog' })
    expect(items[0]).toHaveTextContent('Reclaimed from the backup of Old blog, made')
    expect(items[0]).toHaveTextContent('Added the storage path /data to the app: deploy it to mount it')
    expect(items[1]).toHaveTextContent('From the backup of')
    expect(items[1]).not.toHaveTextContent('Reclaimed')
  })
})

describe('how often the list is refreshed', () => {
  const interval = async (data) => {
    mockApi({ 'GET /api/backups': data })
    const view = renderWithProviders(<AppVolumeBackups app={{ id: 'a1' }} />)
    await screen.findByText('Backups of this app\'s data')
    const query = view.client.getQueryCache().find({ queryKey: ['backups'] })
    return query.observers[0].options.refetchInterval(query)
  }
  test('every 30 seconds when nothing is going on', async () => expect(await interval(overview())).toBe(30_000))
  test('every 3 seconds while a backup is waiting or running', async () => expect(await interval(overview({ backups: [volumeBackup({ status: 'running' })] }))).toBe(3000))
  test('every 3 seconds while a restore is waiting or running, so its end shows up', async () => {
    expect(await interval(overview({ restores: [restore({ status: 'running' })] }))).toBe(3000)
  })
})

describe('restoring', () => {
  const open = async (data = overview(), extra = {}) => {
    const api = section(data, extra)
    await userEvent.click(await screen.findByRole('button', { name: /Restore from the backup of/ }))
    return api
  }
  const post = (api) => api.called('POST', '/api/backups/v1/restore')
  const enc = () => overview({ backups: [volumeBackup({ encrypted: true })] })
  const send = async (api) => { await userEvent.type(screen.getByLabelText('Your password'), 'pw'); await userEvent.click(screen.getByRole('button', { name: 'Restore' })); await waitFor(() => expect(post(api)).toHaveLength(1)) }

  test('a button on each backup that can be restored, and none on one that cannot', async () => {
    section(overview({ backups: [volumeBackup(), volumeBackup({ id: 'v2', restorable: false })] }))
    await screen.findAllByRole('row')
    expect(screen.getAllByRole('button', { name: /Restore from the backup of/ })).toHaveLength(1)
  })
  test('is disabled while a backup or a restore of this app is waiting or running', async () => {
    section(overview({ backups: [volumeBackup(), volumeBackup({ id: 'q', status: 'running', restorable: false, downloadable: false, finishedAt: null })] }))
    expect(await screen.findByRole('button', { name: /Restore from the backup of/ })).toBeDisabled()
    document.body.innerHTML = ''
    section(overview({ restores: [restore({ status: 'running', finishedAt: null })] }))
    expect(await screen.findByRole('button', { name: /Restore from the backup of/ })).toBeDisabled()
  })
  test('the dialog says what will happen, with Replace chosen, the safety backup ticked, and the app named', async () => {
    await open()
    expect(await screen.findByText('Restore the data of Blog')).toBeInTheDocument()
    expect(screen.getByText(/Blog is stopped while this happens/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Replace/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Add over/ })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /Only into empty volumes/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Make a backup of the current data first/ })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled()
  })
  test('sends the password, the mode and the safety choice, then closes and says so', async () => {
    const api = await open(overview(), { 'POST /api/backups/v1/restore': answer(202, { id: 'r1' }) })
    await userEvent.click(screen.getByRole('radio', { name: /Add over/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Make a backup of the current data first/ }))
    await userEvent.type(screen.getByLabelText('Your password'), 'my-password')
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(post(api)).toHaveLength(1))
    expect(post(api)[0].body).toEqual({ password: 'my-password', mode: 'add', safetyBackup: false })
    expect(toasts.success).toHaveBeenCalledWith('A restore of Blog has been asked for')
    await waitFor(() => expect(screen.queryByText('Restore the data of Blog')).toBeNull())
  })
  test('the default choices are Replace with a safety backup', async () => {
    const api = await open(overview(), { 'POST /api/backups/v1/restore': answer(202, { id: 'r1' }) })
    await send(api)
    expect(post(api)[0].body).toEqual({ password: 'pw', mode: 'replace', safetyBackup: true })
  })
  test('the passphrase field is only for an encrypted backup', async () => {
    await open(overview({ backups: [volumeBackup({ encrypted: false })] }))
    expect(screen.queryByLabelText(/Passphrase of this backup/)).toBeNull()
  })
  test('an encrypted backup offers the passphrase, which is optional: nothing is sent when it is empty', async () => {
    const api = await open(enc(), { 'POST /api/backups/v1/restore': answer(202, { id: 'r1' }) })
    expect(screen.getByLabelText(/Passphrase of this backup/)).toBeInTheDocument()
    await send(api)
    expect(post(api)[0].body).not.toHaveProperty('passphrase')
  })
  test('and it is sent when typed', async () => {
    const api = await open(enc(), { 'POST /api/backups/v1/restore': answer(202, { id: 'r1' }) })
    await userEvent.type(screen.getByLabelText(/Passphrase of this backup/), 'old one')
    await send(api)
    expect(post(api)[0].body.passphrase).toBe('old one')
  })
  test('a wrong password is said under the field and the dialog stays', async () => {
    await open(overview(), { 'POST /api/backups/v1/restore': answer(403, { error: 'x', code: 'wrong_password' }) })
    await userEvent.type(screen.getByLabelText('Your password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(await screen.findByText('That is not your current password')).toBeInTheDocument()
    expect(screen.getByText('Restore the data of Blog')).toBeInTheDocument()
  })
  test('another refusal shows the server\'s reason', async () => {
    await open(overview(), { 'POST /api/backups/v1/restore': answer(409, { error: 'A backup of this app is being made: try again when it is done', code: 'backup_running' }) })
    await userEvent.type(screen.getByLabelText('Your password'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(await screen.findByText('A backup of this app is being made: try again when it is done')).toBeInTheDocument()
  })
  test('cancelling asks for nothing', async () => {
    const api = await open()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(post(api)).toHaveLength(0)
    await waitFor(() => expect(screen.queryByText('Restore the data of Blog')).toBeNull())
  })

  test('this app\'s restores are listed with how each went; a failed one shows why, in the row and in a notice', async () => {
    section(overview({ restores: [restore({ id: 'r2', status: 'failed', error: 'The volume at /data is not empty', mode: 'empty', safetyBackup: false, volumeCount: null }), restore(), restore({ id: 'r3', appId: 'a2', appName: 'Shop' })] }))
    const items = await screen.findAllByRole('listitem', { name: 'Restore of Blog' })
    expect(items).toHaveLength(2)
    expect(screen.queryByRole('listitem', { name: 'Restore of Shop' })).toBeNull()
    expect(items[0]).toHaveTextContent('Only into empty volumes · no backup of the current data')
    expect(items[0]).toHaveTextContent('The volume at /data is not empty')
    expect(items[1]).toHaveTextContent('Replace · backup of the current data first · 2 volumes restored')
    expect(screen.getByRole('status', { name: 'Last restore failed' })).toHaveTextContent('The last restore of this app\'s data failed')
  })
  test('no failure notice when the newest restore worked; a warning is shown', async () => {
    section(overview({ restores: [restore({ warning: 'The app could not be started again after the restore: port in use' }), restore({ id: 'r0', status: 'failed', error: 'old' })] }))
    expect(await screen.findByText(/could not be started again after the restore/)).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Last restore failed' })).toBeNull()
  })
  test('while a restore runs, Back up now says Restoring…', async () => {
    section(overview({ restores: [restore({ status: 'running', finishedAt: null })] }))
    expect(await screen.findByRole('button', { name: 'Restoring…' })).toBeDisabled()
  })
  test('no list of restores when there are none, and an older answer without the field still works', async () => {
    section(overview({ restores: [] }))
    await screen.findByText('Backups of this app\'s data')
    expect(screen.queryByText('Restores')).toBeNull()
    document.body.innerHTML = ''
    const old = overview(); delete old.restores
    section(old)
    expect(await screen.findByText('Backups of this app\'s data')).toBeInTheDocument()
  })
})

describe('Shipdok\'s own card with both kinds in the list', () => {
  const both = () => overview({ backups: [volumeBackup({ requestedAt: ago(1), finishedAt: ago(0.5) }), platform()], totalBytes: 3 * 1024 * 1024 + 1024 })
  test('shows only its own backups, counts only their size, and does not say a volume backup was Shipdok\'s last', async () => {
    mockApi({ 'GET /api/backups': both() })
    renderWithProviders(<BackupsCard />)
    expect(await screen.findByText(/Last backup:/)).toHaveTextContent('Last backup: 29 min ago (1.0 KB)')
    expect(screen.getByText(/1\.0 KB in all/)).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(2)
    expect(screen.queryByText('2 volumes')).toBeNull()
  })
  test('a volume backup that is running does not switch off Back up now, and a failed one is not "the last backup failed"', async () => {
    mockApi({ 'GET /api/backups': overview({ backups: [volumeBackup({ id: 'x', status: 'failed', error: 'disk', downloadable: false }), volumeBackup({ id: 'r', status: 'running', downloadable: false, finishedAt: null }), platform()] }) })
    renderWithProviders(<BackupsCard />)
    expect(await screen.findByRole('button', { name: 'Back up now' })).toBeEnabled()
    expect(screen.queryByRole('status', { name: 'Last backup failed' })).toBeNull()
  })
})
