import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BackupsCard from './backups-card'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString()
const backup = (over = {}) => ({
  id: 'b1', status: 'ok', trigger: 'manual', requestedAt: ago(61), startedAt: ago(61), finishedAt: ago(60), sizeBytes: 5 * 1024 * 1024, encrypted: false, verified: true,
  version: '0.1.17', warning: null, error: null, downloadable: true, ...over,
})
const overview = (over = {}) => ({
  backups: [backup()], totalBytes: 5 * 1024 * 1024, schedule: { frequency: 'daily', hour: 3, weekday: 1, keep: 7 }, nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
  encryption: { enabled: false }, persistent: true, ...over,
})
const card = (data = overview(), extra = {}) => { const api = mockApi({ 'GET /api/backups': data, ...extra }); renderWithProviders(<BackupsCard />); return api }

describe('what it shows', () => {
  test('the last good backup and how big everything is, and each backup with its state', async () => {
    card()
    expect(await screen.findByText(/Last backup:/)).toHaveTextContent('Last backup: 1 h ago (5.0 MB)')
    expect(screen.getByText(/5\.0 MB in all/)).toBeInTheDocument()
    const row = screen.getByRole('row', { name: /Made by hand/ })
    expect(within(row).getByText('Done')).toBeInTheDocument()
    expect(within(row).getByText('Not encrypted')).toBeInTheDocument()
    expect(within(row).getByText('Checked')).toBeInTheDocument()
  })
  test('says so when there is no backup yet, with no table', async () => {
    card(overview({ backups: [], totalBytes: 0 }))
    expect(await screen.findByText('No backup has been made yet')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
  test('an encrypted backup says so, and a scheduled one says it was scheduled', async () => {
    card(overview({ backups: [backup({ encrypted: true, trigger: 'scheduled' })] }))
    expect(await screen.findByText('Encrypted')).toBeInTheDocument()
    expect(screen.getByText('Scheduled')).toBeInTheDocument()
    expect(screen.queryByText('Not encrypted')).toBeNull()
  })
  test('a failed backup shows why, in the row and in a notice above; it has no download', async () => {
    card(overview({ backups: [backup({ id: 'f', status: 'failed', error: 'pg_dump failed: no connection', downloadable: false, sizeBytes: null, finishedAt: ago(5), requestedAt: ago(6) }), backup()] }))
    const notice = await screen.findByRole('status', { name: 'Last backup failed' })
    expect(notice).toHaveTextContent('pg_dump failed: no connection')
    expect(screen.getAllByText('pg_dump failed: no connection')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /Download the backup/ })).toHaveLength(1)
  })
  test('no failure notice when the newest one worked, even if an older one failed', async () => {
    card(overview({ backups: [backup(), backup({ id: 'f', status: 'failed', error: 'old problem', downloadable: false })] }))
    await screen.findByText(/Last backup:/)
    expect(screen.queryByRole('status', { name: 'Last backup failed' })).toBeNull()
  })
  test('a warning on a backup (no secrets inside) is shown', async () => {
    card(overview({ backups: [backup({ warning: 'The platform secrets could not be included' })] }))
    expect(await screen.findByText('The platform secrets could not be included')).toBeInTheDocument()
  })
  test('warns when the backups are not on a volume of their own, and only then', async () => {
    card(overview({ persistent: false }))
    expect(await screen.findByRole('status', { name: 'Backups folder' })).toHaveTextContent(/lost when the Shipdok container is replaced/)
    document.body.innerHTML = ''
    card(overview({ persistent: true }))
    await screen.findByText(/Last backup:/)
    expect(screen.queryByRole('status', { name: 'Backups folder' })).toBeNull()
  })
  test('says plainly when the list cannot be loaded', async () => {
    mockApi({ 'GET /api/backups': answer(500, { error: 'boom' }) })
    renderWithProviders(<BackupsCard />)
    expect(await screen.findByText('Could not load the backups')).toBeInTheDocument()
  })
})

describe('backing up now', () => {
  test('asks for one and says so', async () => {
    const api = card(overview(), { 'POST /api/backups': answer(202, { id: 'new' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(api.called('POST', '/api/backups')).toHaveLength(1))
    expect(toasts.success).toHaveBeenCalledWith('A backup has been asked for')
  })
  test('is switched off while one is waiting or running, and says so', async () => {
    card(overview({ backups: [backup({ id: 'q', status: 'running', downloadable: false, sizeBytes: null, finishedAt: null }), backup()] }))
    expect(await screen.findByRole('button', { name: 'Backing up…' })).toBeDisabled()
    expect(screen.getByText('Making…')).toBeInTheDocument()
  })
  test('a 409 (somebody else was quicker) is not an error as such', async () => {
    card(overview(), { 'POST /api/backups': answer(409, { error: 'x', code: 'already_running' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('A backup is already being made'))
  })
  test('another failure shows its message', async () => {
    card(overview(), { 'POST /api/backups': answer(503, { error: 'The queue is down' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('The queue is down'))
  })
})

describe('deleting', () => {
  test('asks first, then deletes that one', async () => {
    const api = card(overview(), { 'DELETE /api/backups/b1': null })
    await userEvent.click(await screen.findByRole('button', { name: /Delete the backup/ }))
    expect(await screen.findByText('Delete this backup?')).toBeInTheDocument()
    expect(api.called('DELETE', '/api/backups/b1')).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.called('DELETE', '/api/backups/b1')).toHaveLength(1))
    expect(toasts.success).toHaveBeenCalledWith('Backup deleted')
  })
  test('cancelling deletes nothing', async () => {
    const api = card()
    await userEvent.click(await screen.findByRole('button', { name: /Delete the backup/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(api.called('DELETE', '/api/backups/b1')).toHaveLength(0)
  })
  test('one that is being made has no delete button', async () => {
    card(overview({ backups: [backup({ status: 'queued', downloadable: false })] }))
    await screen.findByText('Waiting')
    expect(screen.queryByRole('button', { name: /Delete the backup/ })).toBeNull()
  })
})

describe('the schedule', () => {
  test('shows the current one, and Save waits for a change', async () => {
    card()
    expect(await screen.findByLabelText('How often')).toHaveValue('daily')
    expect(screen.getByLabelText('At (UTC)')).toHaveValue('3')
    expect(screen.getByLabelText('Keep the newest')).toHaveValue('7')
    expect(screen.queryByLabelText('On')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled()
  })
  test('the hour says what it is on the local clock', async () => {
    card()
    await screen.findByLabelText('At (UTC)')
    expect(screen.getByText(/^\d{2}:\d{2} on your clock today$/)).toBeInTheDocument()
  })
  test('weekly adds the day; off hides the hour and the day', async () => {
    card()
    await userEvent.selectOptions(await screen.findByLabelText('How often'), 'weekly')
    expect(screen.getByLabelText('On')).toHaveValue('1')
    await userEvent.selectOptions(screen.getByLabelText('How often'), 'off')
    expect(screen.queryByLabelText('On')).toBeNull()
    expect(screen.queryByLabelText('At (UTC)')).toBeNull()
  })
  test('saves what was chosen, as numbers, and answers with a toast', async () => {
    const saved = overview({ schedule: { frequency: 'weekly', hour: 5, weekday: 4, keep: 14 } })
    const api = card(overview(), { 'PUT /api/backups/settings': saved })
    await userEvent.selectOptions(await screen.findByLabelText('How often'), 'weekly')
    await userEvent.selectOptions(screen.getByLabelText('On'), '4')
    await userEvent.selectOptions(screen.getByLabelText('At (UTC)'), '5')
    await userEvent.clear(screen.getByLabelText('Keep the newest'))
    await userEvent.type(screen.getByLabelText('Keep the newest'), '14')
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }))
    await waitFor(() => expect(api.called('PUT', '/api/backups/settings')).toHaveLength(1))
    expect(api.called('PUT', '/api/backups/settings')[0].body).toEqual({ frequency: 'weekly', hour: 5, weekday: 4, keep: 14 })
    expect(toasts.success).toHaveBeenCalledWith('Backup schedule saved')
  })
  test.each(['0', '61', 'abc', '1.5', '', '-3'])('a number to keep of %j is caught before anything is sent', async (text) => {
    const api = card()
    await userEvent.selectOptions(await screen.findByLabelText('How often'), 'weekly') // a change, so Save is on
    await userEvent.clear(screen.getByLabelText('Keep the newest'))
    if (text) await userEvent.type(screen.getByLabelText('Keep the newest'), text)
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }))
    expect(await screen.findByText('A whole number from 1 to 60')).toBeInTheDocument()
    expect(api.called('PUT', '/api/backups/settings')).toHaveLength(0)
  })
  test('the next backup is announced, or nothing when it is off', async () => {
    card()
    expect(await screen.findByText(/Next: /)).toBeInTheDocument()
    document.body.innerHTML = ''
    card(overview({ schedule: { frequency: 'off', hour: 3, weekday: 1, keep: 7 }, nextRunAt: null }))
    expect(await screen.findByText('No automatic backups')).toBeInTheDocument()
    expect(screen.queryByText(/Next: /)).toBeNull()
  })
})

describe('the passphrase', () => {
  const open = async (data = overview()) => { const api = card(data, { 'PUT /api/backups/passphrase': overview({ encryption: { enabled: true } }) }); await userEvent.click(await screen.findByRole('button', { name: /passphrase/i })); return api }
  const fill = async (p = 'correct horse battery staple', again = p, pw = 'my-password') => {
    await userEvent.type(screen.getByLabelText('Passphrase'), p)
    await userEvent.type(screen.getByLabelText('Passphrase again'), again)
    await userEvent.type(screen.getByLabelText('Your password'), pw)
  }
  test('says whether new backups are encrypted, and offers to set or change it', async () => {
    card(overview({ encryption: { enabled: false } }))
    expect(await screen.findByText('New backups are not encrypted')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set a passphrase' })).toBeInTheDocument()
    document.body.innerHTML = ''
    card(overview({ encryption: { enabled: true } }))
    expect(await screen.findByText('New backups are encrypted with your passphrase')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change or remove the passphrase' })).toBeInTheDocument()
  })
  test('warns that it is the only way to open a backup elsewhere, and cannot be saved until that is acknowledged', async () => {
    await open()
    expect(screen.getByText(/the ONLY way to open a backup/)).toBeInTheDocument()
    await fill()
    expect(screen.getByRole('button', { name: 'Save passphrase' })).toBeDisabled()
    await userEvent.click(screen.getByLabelText(/written the passphrase down/))
    expect(screen.getByRole('button', { name: 'Save passphrase' })).toBeEnabled()
  })
  test('sends the passphrase with the password', async () => {
    const api = await open()
    await fill()
    await userEvent.click(screen.getByLabelText(/written the passphrase down/))
    await userEvent.click(screen.getByRole('button', { name: 'Save passphrase' }))
    await waitFor(() => expect(api.called('PUT', '/api/backups/passphrase')).toHaveLength(1))
    expect(api.called('PUT', '/api/backups/passphrase')[0].body).toEqual({ password: 'my-password', passphrase: 'correct horse battery staple' })
    expect(toasts.success).toHaveBeenCalledWith('New backups will be encrypted with that passphrase')
  })
  test.each([
    ['too short', 'short', 'short', 'my-password', 'Use at least 12 characters'],
    ['not the same twice', 'correct horse battery staple', 'correct horse battery stapl', 'my-password', 'The two are not the same'],
    ['no password', 'correct horse battery staple', 'correct horse battery staple', '', 'Enter your password'],
    ['a space at the end', 'correct horse battery ', 'correct horse battery ', 'my-password', 'Do not start or end it with a space'],
  ])('%s is caught before anything is sent', async (_, p, again, pw, message) => {
    const api = await open()
    await userEvent.type(screen.getByLabelText('Passphrase'), p)
    await userEvent.type(screen.getByLabelText('Passphrase again'), again)
    if (pw) await userEvent.type(screen.getByLabelText('Your password'), pw)
    await userEvent.click(screen.getByLabelText(/written the passphrase down/))
    await userEvent.click(screen.getByRole('button', { name: 'Save passphrase' }))
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(api.called('PUT', '/api/backups/passphrase')).toHaveLength(0)
  })
  test('a wrong password is said next to the password box', async () => {
    card(overview(), { 'PUT /api/backups/passphrase': answer(403, { error: 'x', code: 'wrong_password' }) })
    await userEvent.click(await screen.findByRole('button', { name: /passphrase/i }))
    await fill()
    await userEvent.click(screen.getByLabelText(/written the passphrase down/))
    await userEvent.click(screen.getByRole('button', { name: 'Save passphrase' }))
    expect(await screen.findByText('That is not your current password')).toBeInTheDocument()
  })
  test('removing it asks for the password only, and sends null', async () => {
    const api = await open(overview({ encryption: { enabled: true } }))
    await userEvent.click(screen.getByRole('button', { name: 'Stop encrypting…' }))
    expect(screen.queryByLabelText('Passphrase')).toBeNull()
    await userEvent.type(screen.getByLabelText('Your password'), 'my-password')
    await userEvent.click(screen.getByRole('button', { name: 'Stop encrypting' }))
    await waitFor(() => expect(api.called('PUT', '/api/backups/passphrase')).toHaveLength(1))
    expect(api.called('PUT', '/api/backups/passphrase')[0].body).toEqual({ password: 'my-password', passphrase: null })
    expect(toasts.success).toHaveBeenCalledWith('New backups will not be encrypted')
  })
})

describe('downloading', () => {
  const stub = (respond) => {
    URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn()
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body })
      if (String(url) === '/api/backups') return { ok: true, status: 200, json: async () => overview({ backups: [backup({ encrypted: true })] }) }
      return respond(url)
    }))
    return { clicked, calls }
  }
  test('asks for the password, says whether the file is encrypted, and downloads', async () => {
    const { clicked, calls } = stub(() => ({ ok: true, status: 200, blob: async () => new Blob(['x']), headers: { get: () => 'attachment; filename="b.tar.enc"' } }))
    renderWithProviders(<BackupsCard />)
    await userEvent.click(await screen.findByRole('button', { name: /Download the backup/ }))
    expect(await screen.findByText(/encrypted with your backup passphrase/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Your password'), 'my-password')
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(clicked).toHaveBeenCalled())
    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/api/backups/b1/download', method: 'POST', body: JSON.stringify({ password: 'my-password' }) })
    expect(toasts.success).toHaveBeenCalledWith('The download has started')
  })
  test('a plain file says it is not encrypted', async () => {
    mockApi({ 'GET /api/backups': overview() })
    renderWithProviders(<BackupsCard />)
    await userEvent.click(await screen.findByRole('button', { name: /Download the backup/ }))
    expect(await screen.findByText(/NOT encrypted/)).toBeInTheDocument()
  })
  test('a wrong password is said in the dialog, which stays open, and nothing is downloaded', async () => {
    const { clicked } = stub(() => ({ ok: false, status: 403, json: async () => ({ error: 'The current password is not correct' }) }))
    renderWithProviders(<BackupsCard />)
    await userEvent.click(await screen.findByRole('button', { name: /Download the backup/ }))
    await userEvent.type(screen.getByLabelText('Your password'), 'nope')
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(await screen.findByText('That is not your current password')).toBeInTheDocument()
    expect(clicked).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Your password')).toBeInTheDocument()
  })
  test('another refusal shows the server\'s words', async () => {
    stub(() => ({ ok: false, status: 410, json: async () => ({ error: 'The file of that backup is gone from the backups folder' }) }))
    renderWithProviders(<BackupsCard />)
    await userEvent.click(await screen.findByRole('button', { name: /Download the backup/ }))
    await userEvent.type(screen.getByLabelText('Your password'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(await screen.findByText('The file of that backup is gone from the backups folder')).toBeInTheDocument()
  })
})

describe('keeping up to date', () => {
  test('re-reads every few seconds while a backup is waiting or being made', async () => {
    const api = card(overview({ backups: [backup({ status: 'running', downloadable: false, sizeBytes: null, finishedAt: null })] }))
    await screen.findByText('Making…')
    const first = api.called('GET', '/api/backups').length
    await new Promise((r) => setTimeout(r, 3400))
    expect(api.called('GET', '/api/backups').length).toBeGreaterThan(first)
  }, 10_000)
  test('and only now and then when everything is quiet', async () => {
    const api = card()
    await screen.findByText(/Last backup:/)
    const first = api.called('GET', '/api/backups').length
    await new Promise((r) => setTimeout(r, 3400))
    expect(api.called('GET', '/api/backups').length).toBe(first)
  }, 10_000)
})
