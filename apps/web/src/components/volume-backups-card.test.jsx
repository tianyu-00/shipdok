import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import VolumeBackupsCard from './volume-backups-card'
import BackupsCard from './backups-card'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString()
const volumeBackup = (over = {}) => ({
  id: 'v1', kind: 'volumes', appId: 'a1', appName: 'Blog', volumeCount: 2, status: 'ok', trigger: 'scheduled', requestedAt: ago(61), startedAt: ago(61), finishedAt: ago(60),
  sizeBytes: 3 * 1024 * 1024, encrypted: true, verified: true, version: '0.1.19', warning: null, error: null, downloadable: true, ...over,
})
const platform = (over = {}) => ({
  id: 'p1', kind: 'platform', appId: null, appName: null, volumeCount: null, status: 'ok', trigger: 'manual', requestedAt: ago(30), startedAt: ago(30), finishedAt: ago(29),
  sizeBytes: 1024, encrypted: false, verified: true, version: '0.1.19', warning: null, error: null, downloadable: true, ...over,
})
const blog = (over = {}) => ({ id: 'a1', name: 'Blog', volumeCount: 2, sizeBytes: 5 * 1024 * 1024, lastBackupAt: ago(60), enabled: false, stop: false, keep: 3, ...over })
const overview = (over = {}) => ({
  backups: [volumeBackup()], totalBytes: 0, schedule: { frequency: 'daily', hour: 3, weekday: 1, keep: 7 }, nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
  apps: [blog()], encryption: { enabled: true }, persistent: true, ...over,
})
const card = (data = overview(), extra = {}) => { const api = mockApi({ 'GET /api/backups': data, ...extra }); renderWithProviders(<VolumeBackupsCard />); return api }

describe('the apps', () => {
  test('each app with volumes: how many, how big, when it was last backed up, and how it is set', async () => {
    card()
    const item = await screen.findByRole('listitem', { name: 'Blog' })
    expect(item).toHaveTextContent('2 volumes · 5.0 MB · last backup 1 h ago')
    expect(within(item).getByRole('switch', { name: 'Include in the automatic backups' })).not.toBeChecked()
    expect(within(item).getByRole('switch', { name: 'Stop the app while copying' })).not.toBeChecked()
    expect(within(item).getByLabelText('Keep the newest')).toHaveValue('3')
  })
  test('an app that was never backed up says so, and an unmeasured size is left out (never a made-up number)', async () => {
    card(overview({ apps: [blog({ lastBackupAt: null, sizeBytes: null, volumeCount: 1 })], backups: [] }))
    expect(await screen.findByRole('listitem', { name: 'Blog' })).toHaveTextContent('1 volume · never backed up')
    expect(screen.getByRole('listitem', { name: 'Blog' })).not.toHaveTextContent(/MB|KB|GB/)
  })
  test('switches show what is set', async () => {
    card(overview({ apps: [blog({ enabled: true, stop: true, keep: 10 })] }))
    expect(await screen.findByRole('switch', { name: 'Include in the automatic backups' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Stop the app while copying' })).toBeChecked()
    expect(screen.getByLabelText('Keep the newest')).toHaveValue('10')
  })
  test('a number to keep that is not among the usual choices is still shown', async () => {
    card(overview({ apps: [blog({ keep: 4 })] }))
    expect(await screen.findByLabelText('Keep the newest')).toHaveValue('4')
    expect([...screen.getByLabelText('Keep the newest').options].map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '7', '10', '14', '30', '60'])
  })
  test('says what to do when no app has storage, and shows no table', async () => {
    card(overview({ apps: [], backups: [] }))
    expect(await screen.findByText(/No app has persistent storage yet/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
  test('warns on an app that is in the schedule while the schedule is off', async () => {
    card(overview({ schedule: { frequency: 'off', hour: 3, weekday: 1, keep: 7 }, apps: [blog({ enabled: true })] }))
    expect(await screen.findByText(/schedule above is off/)).toBeInTheDocument()
    document.body.innerHTML = ''
    card(overview({ apps: [blog({ enabled: true })] }))
    await screen.findByRole('listitem', { name: 'Blog' })
    expect(screen.queryByText(/schedule above is off/)).toBeNull()
  })
  test('says plainly when the list cannot be loaded', async () => {
    mockApi({ 'GET /api/backups': answer(500, { error: 'boom' }) })
    renderWithProviders(<VolumeBackupsCard />)
    expect(await screen.findByText('Could not load the backups')).toBeInTheDocument()
  })
})

describe('changing how an app is backed up', () => {
  const put = (api) => api.called('PUT', '/api/backups/volumes/a1/settings')
  test('turning the schedule on sends all three values, with that one changed', async () => {
    const api = card(overview({ apps: [blog({ stop: true, keep: 5 })] }), { 'PUT /api/backups/volumes/a1/settings': overview({ apps: [blog({ enabled: true, stop: true, keep: 5 })] }) })
    await userEvent.click(await screen.findByRole('switch', { name: 'Include in the automatic backups' }))
    await waitFor(() => expect(put(api)).toHaveLength(1))
    expect(put(api)[0].body).toEqual({ enabled: true, stop: true, keep: 5 })
    expect(toasts.success).toHaveBeenCalledWith('Saved for Blog')
  })
  test('the stop switch and the number to keep each change only themselves', async () => {
    const api = card(overview({ apps: [blog({ enabled: true })] }), { 'PUT /api/backups/volumes/a1/settings': overview({ apps: [blog({ enabled: true, stop: true })] }) })
    await userEvent.click(await screen.findByRole('switch', { name: 'Stop the app while copying' }))
    await waitFor(() => expect(put(api)).toHaveLength(1))
    expect(put(api)[0].body).toEqual({ enabled: true, stop: true, keep: 3 })
    await userEvent.selectOptions(screen.getByLabelText('Keep the newest'), '14')
    await waitFor(() => expect(put(api)).toHaveLength(2))
    expect(put(api)[1].body).toEqual({ enabled: true, stop: true, keep: 14 })
  })
  test('a refusal shows the server\'s reason', async () => {
    card(overview(), { 'PUT /api/backups/volumes/a1/settings': answer(404, { error: 'App not found' }) })
    await userEvent.click(await screen.findByRole('switch', { name: 'Stop the app while copying' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('App not found'))
  })
})

describe('backing up now', () => {
  test('asks for that app\'s volumes and says so', async () => {
    const api = card(overview(), { 'POST /api/backups/volumes/a1': answer(202, { id: 'n' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(api.called('POST', '/api/backups/volumes/a1')).toHaveLength(1))
    expect(toasts.success).toHaveBeenCalledWith('A backup of Blog\'s data has been asked for')
  })
  test('is switched off for the app whose backup is waiting or running, and only for that one', async () => {
    card(overview({
      apps: [blog(), blog({ id: 'a2', name: 'Shop' })],
      backups: [volumeBackup({ id: 'q', status: 'running', downloadable: false, sizeBytes: null, finishedAt: null })],
    }))
    const blogItem = await screen.findByRole('listitem', { name: 'Blog' })
    expect(within(blogItem).getByRole('button', { name: 'Backing up…' })).toBeDisabled()
    expect(within(screen.getByRole('listitem', { name: 'Shop' })).getByRole('button', { name: 'Back up now' })).toBeEnabled()
  })
  test('a Shipdok backup that is running does not stop an app from being backed up', async () => {
    card(overview({ backups: [platform({ status: 'running', downloadable: false, finishedAt: null })] }))
    expect(await screen.findByRole('button', { name: 'Back up now' })).toBeEnabled()
  })
  test('a 409 (somebody was quicker) is said gently; another failure shows its message', async () => {
    card(overview(), { 'POST /api/backups/volumes/a1': answer(409, { error: 'x', code: 'already_running' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('A backup of this app is already being made'))
    document.body.innerHTML = ''
    vi.clearAllMocks()
    card(overview(), { 'POST /api/backups/volumes/a1': answer(400, { error: 'This app has no persistent volumes' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('This app has no persistent volumes'))
  })
})

describe('the list of volume backups', () => {
  test('names the app and the number of volumes, and shows only the apps\' backups (not Shipdok\'s own)', async () => {
    card(overview({ backups: [volumeBackup(), platform()] }))
    const row = await screen.findByRole('row', { name: /Blog/ })
    expect(within(row).getByText('2 volumes')).toBeInTheDocument()
    expect(within(row).getByText('Encrypted')).toBeInTheDocument()
    expect(within(row).getByText('Scheduled')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(2)
    expect(screen.getByRole('columnheader', { name: 'App' })).toBeInTheDocument()
  })
  test('a backup of an app that has been deleted still shows under the name it had', async () => {
    card(overview({ apps: [], backups: [volumeBackup({ appId: null, appName: 'Old blog' })] }))
    expect(await screen.findByRole('row', { name: /Old blog/ })).toBeInTheDocument()
  })
  test('a failed one shows why, here and in a notice above, and has no download', async () => {
    card(overview({ backups: [volumeBackup({ id: 'f', status: 'failed', error: 'Not enough free disk space: …', downloadable: false, sizeBytes: null })] }))
    const notice = await screen.findByRole('status', { name: 'Last app backup failed' })
    expect(notice).toHaveTextContent('The last backup of Blog\'s data failed')
    expect(notice).toHaveTextContent('Not enough free disk space')
    expect(screen.queryByRole('button', { name: /Download the backup/ })).toBeNull()
  })
  test('no failure notice when the newest worked', async () => {
    card(overview({ backups: [volumeBackup(), volumeBackup({ id: 'f', status: 'failed', error: 'old', downloadable: false })] }))
    await screen.findAllByRole('row', { name: /Blog/ })
    expect(screen.queryByRole('status', { name: 'Last app backup failed' })).toBeNull()
  })
  test('a warning (the app did not start again) is shown', async () => {
    card(overview({ backups: [volumeBackup({ warning: 'The app could not be started again after the copy: port in use' })] }))
    expect(await screen.findByText(/could not be started again/)).toBeInTheDocument()
  })
  test('download asks for the password and names the app\'s data, not "every secret"', async () => {
    card()
    await userEvent.click(await screen.findByRole('button', { name: /Download the backup/ }))
    expect(await screen.findByText(/all the data in the volumes of Blog/)).toBeInTheDocument()
    expect(screen.queryByText(/every secret Shipdok has/)).toBeNull()
  })
  test('delete asks first, then deletes that one', async () => {
    const api = card(overview(), { 'DELETE /api/backups/v1': null })
    await userEvent.click(await screen.findByRole('button', { name: /Delete the backup/ }))
    expect(api.called('DELETE', '/api/backups/v1')).toHaveLength(0)
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.called('DELETE', '/api/backups/v1')).toHaveLength(1))
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

describe('how often the list is refreshed', () => {
  const interval = async (data) => {
    mockApi({ 'GET /api/backups': data })
    const view = renderWithProviders(<VolumeBackupsCard />)
    await screen.findAllByRole('listitem')
    const query = view.client.getQueryCache().find({ queryKey: ['backups'] })
    return query.observers[0].options.refetchInterval(query)
  }
  test('every 30 seconds when nothing is going on', async () => expect(await interval(overview({ restores: [] }))).toBe(30_000))
  test('every 3 seconds while a backup is waiting or running', async () => expect(await interval(overview({ backups: [volumeBackup({ status: 'running' })], restores: [] }))).toBe(3000))
  test('every 3 seconds while a restore is waiting or running, so its end shows up', async () => {
    expect(await interval(overview({ restores: [{ id: 'r', status: 'running', appId: 'a1', appName: 'Blog', mode: 'replace', safetyBackup: true }] }))).toBe(3000)
  })
})

describe('restoring', () => {
  const restore = (over = {}) => ({
    id: 'r1', backupId: 'v1', appId: 'a1', appName: 'Blog', backupMadeAt: ago(60), mode: 'replace', safetyBackup: true, safetyBackupId: null, status: 'ok', requestedAt: ago(10), startedAt: ago(10), finishedAt: ago(9),
    volumeCount: 2, warning: null, error: null, ...over,
  })
  const withRestorable = (over = {}) => overview({ backups: [volumeBackup({ restorable: true })], restores: [], ...over })
  const open = async (data = withRestorable(), extra = {}) => {
    const api = card(data, extra)
    await userEvent.click(await screen.findByRole('button', { name: /Restore from the backup of/ }))
    return api
  }
  const post = (api) => api.called('POST', '/api/backups/v1/restore')

  test('a button on each backup that can be restored, and none on one that cannot', async () => {
    card(overview({ backups: [volumeBackup({ restorable: true }), volumeBackup({ id: 'v2', restorable: false, appId: null })], restores: [] }))
    await screen.findAllByRole('row', { name: /Blog/ })
    expect(screen.getAllByRole('button', { name: /Restore from the backup of/ })).toHaveLength(1)
  })
  test('is disabled while a backup or a restore of that app is waiting or running, not for others', async () => {
    card(withRestorable({ backups: [volumeBackup({ restorable: true }), volumeBackup({ id: 'q', status: 'running', restorable: false, downloadable: false, finishedAt: null })] }))
    expect(await screen.findByRole('button', { name: /Restore from the backup of/ })).toBeDisabled()
    document.body.innerHTML = ''
    card(withRestorable({ restores: [restore({ status: 'running', finishedAt: null })] }))
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
    const api = await open(withRestorable(), { 'POST /api/backups/v1/restore': answer(202, { id: 'r1' }) })
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
    const api = await open(withRestorable(), { 'POST /api/backups/v1/restore': answer(202, { id: 'r1' }) })
    await userEvent.type(screen.getByLabelText('Your password'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(post(api)).toHaveLength(1))
    expect(post(api)[0].body).toEqual({ password: 'pw', mode: 'replace', safetyBackup: true })
  })
  const enc = () => withRestorable({ backups: [volumeBackup({ restorable: true, encrypted: true })] })
  const send = async (api) => { await userEvent.type(screen.getByLabelText('Your password'), 'pw'); await userEvent.click(screen.getByRole('button', { name: 'Restore' })); await waitFor(() => expect(post(api)).toHaveLength(1)) }
  test('the passphrase field is only for an encrypted backup', async () => {
    await open(withRestorable({ backups: [volumeBackup({ restorable: true, encrypted: false })] }))
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
    await open(withRestorable(), { 'POST /api/backups/v1/restore': answer(403, { error: 'x', code: 'wrong_password' }) })
    await userEvent.type(screen.getByLabelText('Your password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(await screen.findByText('That is not your current password')).toBeInTheDocument()
    expect(screen.getByText('Restore the data of Blog')).toBeInTheDocument()
  })
  test('another refusal shows the server\'s reason', async () => {
    await open(withRestorable(), { 'POST /api/backups/v1/restore': answer(409, { error: 'A backup of this app is being made: try again when it is done', code: 'backup_running' }) })
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

  test('the restores are listed with how each went; a failed one shows why, in the row and in a notice', async () => {
    card(withRestorable({ restores: [restore({ id: 'r2', status: 'failed', error: 'The volume at /data is not empty', mode: 'empty', safetyBackup: false, volumeCount: null }), restore()] }))
    const items = await screen.findAllByRole('listitem', { name: 'Restore of Blog' })
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Only into empty volumes · no backup of the current data')
    expect(items[0]).toHaveTextContent('The volume at /data is not empty')
    expect(items[1]).toHaveTextContent('Replace · backup of the current data first · 2 volumes restored')
    expect(screen.getByRole('status', { name: 'Last restore failed' })).toHaveTextContent('The last restore of Blog\'s data failed')
  })
  test('no failure notice when the newest restore worked; a warning is shown', async () => {
    card(withRestorable({ restores: [restore({ warning: 'The app could not be started again after the restore: port in use' }), restore({ id: 'r0', status: 'failed', error: 'old' })] }))
    expect(await screen.findByText(/could not be started again after the restore/)).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Last restore failed' })).toBeNull()
  })
  test('while a restore runs, the app says so and Back up now is off', async () => {
    card(withRestorable({ restores: [restore({ status: 'running', finishedAt: null })] }))
    expect(await within(await screen.findByRole('listitem', { name: 'Blog' })).findByRole('button', { name: 'Restoring…' })).toBeDisabled()
    expect(screen.getByText('Restoring…', { selector: '[data-slot=badge]' })).toBeInTheDocument()
  })
  test('no list of restores when there are none, and an older answer without the field still works', async () => {
    card(withRestorable({ restores: [] }))
    await screen.findByRole('listitem', { name: 'Blog' })
    expect(screen.queryByText('Restores')).toBeNull()
    document.body.innerHTML = ''
    const old = withRestorable(); delete old.restores
    card(old)
    expect(await screen.findByRole('listitem', { name: 'Blog' })).toBeInTheDocument()
  })
  test('a backup made before a restore says so', async () => {
    card(withRestorable({ backups: [volumeBackup({ trigger: 'before_restore', restorable: true })] }))
    expect(await screen.findByText('Before a restore')).toBeInTheDocument()
  })
  test('a 409 because a restore is running is not reported as "a backup is already being made"', async () => {
    card(overview(), { 'POST /api/backups/volumes/a1': answer(409, { error: 'A restore of this app is waiting or running', code: 'restore_running' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('A restore of this app is waiting or running'))
  })
})
