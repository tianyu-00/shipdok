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
