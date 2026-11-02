// The Storage page's card for backups that no app page lists any more (the app was deleted, or it has no storage now).
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import KeptBackups from './kept-backups'
import { mockApi, answer, renderWithProviders, pick, listed } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString()
let n = 0
const vb = (over = {}) => { n += 1; return {
  id: `v${n}`, kind: 'volumes', appId: 'gone', appName: 'Old blog', volumeCount: 2, status: 'ok', trigger: 'scheduled', requestedAt: ago(100 - n), startedAt: ago(100 - n), finishedAt: ago(99 - n),
  sizeBytes: 3 * 1024 * 1024, encrypted: true, verified: true, version: '0.1.19', warning: null, error: null, downloadable: true, restorable: false, ...over,
} }
const overview = (over = {}) => ({ backups: [], restores: [], totalBytes: 0, schedule: { frequency: 'daily', hour: 3, weekday: 1, keep: 7 }, nextRunAt: null, apps: [{ id: 'a1', name: 'Blog' }], encryption: { enabled: false }, persistent: true, ...over })
const card = (data) => { const api = mockApi({ 'GET /api/backups': data }); const view = renderWithProviders(<KeptBackups />); return { api, view } }
const settled = (api) => waitFor(() => expect(api.called('GET', '/api/backups')).toHaveLength(1))

describe('when it shows', () => {
  test('there is no card at all when every backup belongs to an app that is there', async () => {
    const { api, view } = card(overview({ backups: [vb({ appId: 'a1', appName: 'Blog', restorable: true })] }))
    await settled(api)
    await waitFor(() => expect(view.container.querySelectorAll('[data-slot=card], table, p')).toHaveLength(0))
    expect(screen.queryByText('Backups kept without an app')).toBeNull()
  })
  test('a backup of a deleted app (no app id) is listed, under the name it had', async () => {
    card(overview({ backups: [vb({ appId: null, appName: 'Old blog' })] }))
    expect(await screen.findByText('Backups kept without an app')).toBeInTheDocument()
    expect(within(screen.getByRole('row', { name: /Old blog/ })).getByText('2 volumes')).toBeInTheDocument()
  })
  test('a backup of an app that still exists but has no storage now (it is not in the list of apps with storage) is listed too', async () => {
    card(overview({ backups: [vb({ appId: 'a9', appName: 'Wiki', restorable: true })] }))
    expect(await screen.findByRole('row', { name: /Wiki/ })).toBeInTheDocument()
  })
  test('only the ones without an app are in it; the others stay on their app\'s page', async () => {
    card(overview({ backups: [vb({ appId: 'a1', appName: 'Blog' }), vb({ appId: null, appName: 'Old blog' }), vb({ appId: 'a9', appName: 'Wiki' })] }))
    await screen.findByText('Backups kept without an app')
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(screen.queryByText('Blog')).toBeNull()
  })
  test('Shipdok\'s own backups are not in it', async () => {
    const { api } = card(overview({ backups: [{ ...vb(), kind: 'platform', appId: null, appName: null }] }))
    await settled(api)
    await waitFor(() => expect(screen.queryByText('Backups kept without an app')).toBeNull())
  })
  test('one that is still being made is not (its app is there)', async () => {
    const { api } = card(overview({ backups: [vb({ appId: 'a9', status: 'running', downloadable: false, sizeBytes: null, finishedAt: null }), vb({ appId: 'a9', status: 'queued', downloadable: false })] }))
    await settled(api)
    await waitFor(() => expect(screen.queryByText('Backups kept without an app')).toBeNull())
  })
  test('a failed one is listed, so it can be deleted, with its reason', async () => {
    card(overview({ backups: [vb({ appId: null, status: 'failed', error: 'It broke', downloadable: false, sizeBytes: null })] }))
    expect(await screen.findByText('It broke')).toBeInTheDocument()
  })
  test('an older answer without the list of apps does not break it', async () => {
    const old = overview({ backups: [vb({ appId: null })] }); delete old.apps
    card(old)
    expect(await screen.findByText('Backups kept without an app')).toBeInTheDocument()
  })
})

describe('what can be done with them', () => {
  test('download, delete and reclaim, and no plain restore (there is no app of its own to restore to)', async () => {
    card(overview({ backups: [vb({ appId: 'a9', restorable: true })] }))
    expect(await screen.findByRole('button', { name: /Download the backup/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Delete the backup/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reclaim the backup of .* into an app/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Restore from/ })).toBeNull()
  })
  test('a failed backup has nothing to reclaim', async () => {
    card(overview({ backups: [vb({ appId: null, status: 'failed', error: 'x', downloadable: false })] }))
    await screen.findByText('x')
    expect(screen.queryByRole('button', { name: /Reclaim the backup/ })).toBeNull()
  })
  test('delete asks first, then deletes that one', async () => {
    const api = mockApi({ 'GET /api/backups': overview({ backups: [vb({ id: 'k1', appId: null })] }), 'DELETE /api/backups/k1': null })
    renderWithProviders(<KeptBackups />)
    await userEvent.click(await screen.findByRole('button', { name: /Delete the backup/ }))
    expect(api.called('DELETE', '/api/backups/k1')).toHaveLength(0)
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.called('DELETE', '/api/backups/k1')).toHaveLength(1))
  })
  test('download asks for the password and names the data it holds', async () => {
    card(overview({ backups: [vb({ appId: null })] }))
    await userEvent.click(await screen.findByRole('button', { name: /Download the backup/ }))
    expect(await screen.findByText(/all the data in the volumes of Old blog/)).toBeInTheDocument()
  })
})

describe('the reclaim dialog', () => {
  const apps = [{ id: 'a2', name: 'Shop', deleting_at: null }, { id: 'a1', name: 'Blog', deleting_at: null }]
  const here = (backup, extra = {}) => {
    const api = mockApi({ 'GET /api/backups': overview({ backups: [backup] }), 'GET /api/apps': apps, 'GET /api/apps/a1/volumes': { volumes: [] }, 'GET /api/apps/a2/volumes': { volumes: [{ id: 'x', path: '/data', state: 'in_use' }] }, ...extra })
    renderWithProviders(<KeptBackups />)
    return api
  }
  const open = async (backup = vb({ appId: null, paths: ['/data', '/app/data/whatisthis'] }), extra) => {
    const api = here(backup, extra)
    await userEvent.click(await screen.findByRole('button', { name: /Reclaim the backup of/ }))
    return api
  }
  const post = (api, id) => api.called('POST', `/api/backups/${id}/reclaim`)
  const dialog = () => within(screen.getByRole('dialog'))

  test('says what it does: the files go into the app you choose, new paths are added to it, mounted from the next deployment', async () => {
    await open()
    expect(await screen.findByText('Reclaim the data of Old blog')).toBeInTheDocument()
    expect(screen.getByText('added to the app')).toBeInTheDocument()
    expect(await listed(screen.getByLabelText('Put it into'))).toEqual(['Choose an app…', 'Blog', 'Shop'])
    expect(dialog().getByRole('button', { name: 'Reclaim' })).toBeDisabled()
  })
  test('shows, for the chosen app, which paths will be ADDED and which it already keeps', async () => {
    await open()
    await pick(await screen.findByLabelText('Put it into'), 'a1')
    const box = await screen.findByLabelText('What will happen')
    expect(box).toHaveTextContent('Storage paths that will be added to Blog: /data, /app/data/whatisthis')
    expect(box).not.toHaveTextContent('already keeps')
    await pick(screen.getByLabelText('Put it into'), 'a2')
    await waitFor(() => expect(screen.getByLabelText('What will happen')).toHaveTextContent('Storage paths that will be added to Shop: /app/data/whatisthis'))
    expect(screen.getByLabelText('What will happen')).toHaveTextContent('Paths Shop already keeps, restored into as you choose below: /data')
  })
  test('a backup made before its paths were recorded says it generally', async () => {
    await open(vb({ appId: null, paths: null }))
    await pick(await screen.findByLabelText('Put it into'), 'a1')
    expect(await screen.findByLabelText('What will happen')).toHaveTextContent('The storage paths this backup holds that Blog does not keep yet will be added to it')
  })
  test('the safety-backup box is only there when something the app already keeps will be written to', async () => {
    await open()
    await pick(await screen.findByLabelText('Put it into'), 'a1')
    await waitFor(() => expect(screen.getByLabelText('What will happen')).toBeInTheDocument())
    expect(screen.queryByRole('checkbox', { name: /Make a backup of the current data first/ })).toBeNull()
    await pick(screen.getByLabelText('Put it into'), 'a2')
    expect(await screen.findByRole('checkbox', { name: /Make a backup of the current data first/ })).toBeChecked()
  })
  test('sends the app, the mode, the safety choice and the password, then says so and closes', async () => {
    const api = await open(vb({ id: 'k9', appId: null, paths: ['/data'] }), { 'POST /api/backups/k9/reclaim': answer(202, { id: 'r' }) })
    await pick(await screen.findByLabelText('Put it into'), 'a2')
    await userEvent.click(screen.getByRole('radio', { name: /Add over/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Make a backup of the current data first/ }))
    await userEvent.type(screen.getByLabelText('Your password'), 'pw')
    await userEvent.click(dialog().getByRole('button', { name: 'Reclaim' }))
    await waitFor(() => expect(post(api, 'k9')).toHaveLength(1))
    expect(post(api, 'k9')[0].body).toEqual({ password: 'pw', appId: 'a2', mode: 'add', safetyBackup: false })
    expect(toasts.success).toHaveBeenCalledWith('The data of Old blog is being put into Shop')
    await waitFor(() => expect(screen.queryByText('Reclaim the data of Old blog')).toBeNull())
  })
  test('the defaults are Replace and a safety backup', async () => {
    const api = await open(vb({ id: 'k9', appId: null, paths: ['/data'] }), { 'POST /api/backups/k9/reclaim': answer(202, { id: 'r' }) })
    await pick(await screen.findByLabelText('Put it into'), 'a2')
    await userEvent.type(screen.getByLabelText('Your password'), 'pw')
    await userEvent.click(dialog().getByRole('button', { name: 'Reclaim' }))
    await waitFor(() => expect(post(api, 'k9')).toHaveLength(1))
    expect(post(api, 'k9')[0].body).toMatchObject({ mode: 'replace', safetyBackup: true })
  })
  test('the passphrase field is only for an encrypted backup, and is sent only when typed', async () => {
    await open(vb({ appId: null, encrypted: false }))
    expect(screen.queryByLabelText(/Passphrase of this backup/)).toBeNull()
  })
  test('an encrypted one sends the passphrase when typed', async () => {
    const api = await open(vb({ id: 'k8', appId: null, encrypted: true, paths: ['/data'] }), { 'POST /api/backups/k8/reclaim': answer(202, { id: 'r' }) })
    await pick(await screen.findByLabelText('Put it into'), 'a1')
    await userEvent.type(screen.getByLabelText(/Passphrase of this backup/), 'old one')
    await userEvent.type(screen.getByLabelText('Your password'), 'pw')
    await userEvent.click(dialog().getByRole('button', { name: 'Reclaim' }))
    await waitFor(() => expect(post(api, 'k8')).toHaveLength(1))
    expect(post(api, 'k8')[0].body.passphrase).toBe('old one')
  })
  test('needs an app and a password before it can be sent', async () => {
    await open()
    await userEvent.type(screen.getByLabelText('Your password'), 'pw')
    expect(dialog().getByRole('button', { name: 'Reclaim' })).toBeDisabled()
    await pick(screen.getByLabelText('Put it into'), 'a1')
    expect(dialog().getByRole('button', { name: 'Reclaim' })).toBeEnabled()
  })
  test('a wrong password and another refusal are said in the dialog, which stays open', async () => {
    await open(vb({ id: 'k7', appId: null, paths: ['/data'] }), { 'POST /api/backups/k7/reclaim': answer(403, { error: 'x', code: 'wrong_password' }) })
    await pick(await screen.findByLabelText('Put it into'), 'a1')
    await userEvent.type(screen.getByLabelText('Your password'), 'bad')
    await userEvent.click(dialog().getByRole('button', { name: 'Reclaim' }))
    expect(await screen.findByText('That is not your current password')).toBeInTheDocument()
    expect(screen.getByText('Reclaim the data of Old blog')).toBeInTheDocument()
  })
  test('the server\'s reason is shown (paths that do not fit)', async () => {
    await open(vb({ id: 'k6', appId: null, paths: ['/data'] }), { 'POST /api/backups/k6/reclaim': answer(400, { error: 'The storage paths of this backup cannot be added to Blog: /data/inner is inside /data', code: 'bad_path' }) })
    await pick(await screen.findByLabelText('Put it into'), 'a1')
    await userEvent.type(screen.getByLabelText('Your password'), 'pw')
    await userEvent.click(dialog().getByRole('button', { name: 'Reclaim' }))
    expect(await screen.findByText(/cannot be added to Blog/)).toBeInTheDocument()
  })
  test('cancelling sends nothing', async () => {
    const api = await open(vb({ id: 'k5', appId: null }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(post(api, 'k5')).toHaveLength(0)
  })
})
