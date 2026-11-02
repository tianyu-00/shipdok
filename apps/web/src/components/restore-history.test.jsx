// The history of an app's restores in its Settings tab: pages (5 until changed), how many it remembers, Dismiss on the red notice, Clear.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AppVolumeBackups from './app-volume-backups'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => { vi.clearAllMocks(); localStorage.clear() })
afterEach(() => vi.restoreAllMocks())

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString()
const OFF = { frequency: 'off', hour: 3, weekday: 1 }
const blog = (over = {}) => ({ id: 'a1', name: 'Blog', volumeCount: 1, sizeBytes: 1024, lastBackupAt: null, schedule: OFF, nextRunAt: null, stop: false, keep: 2, restoreKeep: 10, ...over })
const restore = (n, over = {}) => ({
  id: `r${n}`, backupId: null, appId: 'a1', appName: 'Blog', backupMadeAt: ago(500), mode: 'replace', safetyBackup: true, safetyBackupId: null, status: 'ok', requestedAt: ago(n * 2), startedAt: ago(n * 2), finishedAt: ago(n * 2 - 1),
  volumeCount: 1, warning: null, error: null, reclaim: false, backupAppName: null, dismissed: false, ...over,
})
const many = (count, over = {}) => Array.from({ length: count }, (_, i) => restore(i + 1, over)) // newest first, as the API sends them
const overview = (over = {}) => ({ backups: [], restores: [], totalBytes: 0, schedule: { frequency: 'daily', hour: 3, weekday: 1, keep: 7 }, nextRunAt: null, apps: [blog()], encryption: { enabled: false }, persistent: true, ...over })
const section = (data, extra = {}) => { const api = mockApi({ 'GET /api/backups': data, ...extra }); renderWithProviders(<AppVolumeBackups app={{ id: 'a1' }} />); return api }
const items = () => screen.getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))
const put = (api) => api.called('PUT', '/api/backups/volumes/a1/settings')

describe('pages', () => {
  test('show 5 restores at a time until the person says otherwise, with how many there are', async () => {
    section(overview({ restores: many(12) }))
    expect(await screen.findByText('(12)')).toBeInTheDocument()
    expect(items()).toHaveLength(5)
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    expect(screen.getByLabelText('Per page')).toHaveValue('5')
  })
  test('Older and Newer move between pages; the first page has no Newer and the last no Older', async () => {
    section(overview({ restores: many(12) }))
    const newer = await screen.findByRole('button', { name: 'Newer' })
    const older = screen.getByRole('button', { name: 'Older' })
    expect(newer).toBeDisabled()
    await userEvent.click(older)
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument()
    expect(newer).toBeEnabled()
    await userEvent.click(older)
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument()
    expect(items()).toHaveLength(2)
    expect(older).toBeDisabled()
    await userEvent.click(newer)
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument()
  })
  test('the page size can be chosen, goes back to the first page, and is remembered by this browser', async () => {
    section(overview({ restores: many(12) }))
    await userEvent.click(await screen.findByRole('button', { name: 'Older' }))
    await userEvent.selectOptions(screen.getByLabelText('Per page'), '10')
    expect(items()).toHaveLength(10)
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
    expect(localStorage.getItem('shipdok.restorePageSize')).toBe('10')
  })
  test('a remembered page size is used, and a nonsense one is ignored', async () => {
    localStorage.setItem('shipdok.restorePageSize', '25')
    section(overview({ restores: many(30) }))
    await screen.findByText('(30)')
    expect(items()).toHaveLength(25)
  })
  test('a nonsense remembered size means 5', async () => {
    localStorage.setItem('shipdok.restorePageSize', '7')
    section(overview({ restores: many(8) }))
    await screen.findByText('(8)')
    expect(items()).toHaveLength(5)
  })
  test('with few restores there are no page controls', async () => {
    section(overview({ restores: many(3) }))
    await screen.findByText('(3)')
    expect(screen.queryByText(/Page 1 of/)).toBeNull()
    expect(screen.queryByLabelText('Per page')).toBeNull()
  })
  test('when the list gets shorter the page falls back to the last one that exists', async () => {
    const api = mockApi({ 'GET /api/backups': overview({ restores: many(12) }) })
    const { client } = renderWithProviders(<AppVolumeBackups app={{ id: 'a1' }} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Older' }))
    await userEvent.click(screen.getByRole('button', { name: 'Older' }))
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument()
    client.setQueryData(['backups'], overview({ restores: many(6) }))
    expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument()
    expect(items()).toHaveLength(1)
    expect(api.called('GET', '/api/backups').length).toBeGreaterThan(0)
  })
  test('only this app\'s restores are listed', async () => {
    section(overview({ restores: [restore(1), restore(2, { id: 'x', appId: 'other', appName: 'Wiki' })] }))
    await screen.findByText('(1)')
    expect(items()).toEqual(['Restore of Blog'])
  })
})

describe('how many it remembers', () => {
  test('the field shows the number the app has, or is empty (all) when it keeps every restore', async () => {
    section(overview({ apps: [blog({ restoreKeep: 7 })] }))
    expect(await screen.findByLabelText('Remember this many restores')).toHaveValue('7')
  })
  test('empty means all', async () => {
    section(overview({ apps: [blog({ restoreKeep: null })] }))
    expect(await screen.findByLabelText('Remember this many restores')).toHaveValue('')
  })
  test('a new number is saved when the field is left, together with the other settings, and answered with the new list', async () => {
    const api = section(overview(), { 'PUT /api/backups/volumes/a1/settings': overview({ apps: [blog({ restoreKeep: 3 })] }) })
    const field = await screen.findByLabelText('Remember this many restores')
    await userEvent.clear(field)
    await userEvent.type(field, '3')
    expect(put(api)).toHaveLength(0)
    await userEvent.tab()
    await waitFor(() => expect(put(api)).toHaveLength(1))
    expect(put(api)[0].body).toEqual({ ...OFF, stop: false, keep: 2, restoreKeep: 3 })
    await waitFor(() => expect(screen.getByLabelText('Remember this many restores')).toHaveValue('3'))
  })
  test('the field follows the app: a number changed elsewhere shows up, and a refused number goes back to the saved one', async () => {
    const api = mockApi({ 'GET /api/backups': overview(), 'PUT /api/backups/volumes/a1/settings': answer(404, { error: 'App not found' }) })
    const { client } = renderWithProviders(<AppVolumeBackups app={{ id: 'a1' }} />)
    expect(await screen.findByLabelText('Remember this many restores')).toHaveValue('10')
    client.setQueryData(['backups'], overview({ apps: [blog({ restoreKeep: 8 })] }))
    await waitFor(() => expect(screen.getByLabelText('Remember this many restores')).toHaveValue('8'))
    client.setQueryData(['backups'], overview({ apps: [blog({ restoreKeep: null })] }))
    await waitFor(() => expect(screen.getByLabelText('Remember this many restores')).toHaveValue(''))
    expect(api.called('PUT', '/api/backups/volumes/a1/settings')).toHaveLength(0)
  })
  test('Enter saves it too', async () => {
    const api = section(overview(), { 'PUT /api/backups/volumes/a1/settings': overview() })
    const field = await screen.findByLabelText('Remember this many restores')
    await userEvent.clear(field)
    await userEvent.type(field, '25{Enter}')
    await waitFor(() => expect(put(api)).toHaveLength(1))
    expect(put(api)[0].body.restoreKeep).toBe(25)
  })
  test('empty is sent as null (all of them)', async () => {
    const api = section(overview(), { 'PUT /api/backups/volumes/a1/settings': overview({ apps: [blog({ restoreKeep: null })] }) })
    const field = await screen.findByLabelText('Remember this many restores')
    await userEvent.clear(field)
    await userEvent.tab()
    await waitFor(() => expect(put(api)).toHaveLength(1))
    expect(put(api)[0].body.restoreKeep).toBeNull()
  })
  test.each([['0'], ['-3'], ['2.5'], ['abc'], ['1000001']])('%s is not sent: the field says what is wanted', async (bad) => {
    const api = section(overview(), { 'PUT /api/backups/volumes/a1/settings': overview() })
    const field = await screen.findByLabelText('Remember this many restores')
    await userEvent.clear(field)
    await userEvent.type(field, bad)
    await userEvent.tab()
    expect(await screen.findByText('A whole number from 1, or empty for all')).toBeInTheDocument()
    expect(put(api)).toHaveLength(0)
  })
  test('leaving the field without a change saves nothing, and the other settings never send it', async () => {
    const api = section(overview(), { 'PUT /api/backups/volumes/a1/settings': overview() })
    const field = await screen.findByLabelText('Remember this many restores')
    await userEvent.click(field)
    await userEvent.tab()
    expect(put(api)).toHaveLength(0)
    await userEvent.click(screen.getByRole('switch', { name: 'Stop the app while copying' }))
    await waitFor(() => expect(put(api)).toHaveLength(1))
    expect(put(api)[0].body).not.toHaveProperty('restoreKeep')
  })
  test('a refused save says why', async () => {
    section(overview(), { 'PUT /api/backups/volumes/a1/settings': answer(404, { error: 'App not found' }) })
    const field = await screen.findByLabelText('Remember this many restores')
    await userEvent.clear(field)
    await userEvent.type(field, '4')
    await userEvent.tab()
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('App not found'))
  })
})

describe('the red notice of a failed restore', () => {
  const failed = (over = {}) => restore(1, { status: 'failed', error: 'Not enough free disk space', ...over })
  test('has a Dismiss button that closes it for good and leaves the restore in the list', async () => {
    const api = section(overview({ restores: [failed()] }), { 'POST /api/backups/restores/r1/dismiss': overview({ restores: [failed({ dismissed: true })] }) })
    const notice = await screen.findByRole('status', { name: 'Last restore failed' })
    await userEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(api.called('POST', '/api/backups/restores/r1/dismiss')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Last restore failed' })).toBeNull())
    expect(items()).toEqual(['Restore of Blog'])
    expect(screen.getByText('Not enough free disk space')).toBeInTheDocument()
  })
  test('an already dismissed one shows no notice, but a newer failure does', async () => {
    section(overview({ restores: [failed({ id: 'r2', dismissed: false, error: 'Newer problem' }), failed({ id: 'r1', dismissed: true })] }))
    expect(await screen.findByText('Newer problem', { selector: '[data-slot=alert-description]' })).toBeInTheDocument()
  })
  test('a dismissed newest failure shows nothing even when an older one was not dismissed', async () => {
    section(overview({ restores: [failed({ id: 'r2', dismissed: true }), failed({ id: 'r1', dismissed: false })] }))
    await screen.findByText('(2)')
    expect(screen.queryByRole('status', { name: 'Last restore failed' })).toBeNull()
  })
  test('a restore that worked has no notice and no Dismiss', async () => {
    section(overview({ restores: [restore(1)] }))
    await screen.findByText('(1)')
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })
  test('a refusal is said', async () => {
    section(overview({ restores: [failed()] }), { 'POST /api/backups/restores/r1/dismiss': answer(404, { error: 'No failed restore with that id' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('No failed restore with that id'))
    expect(screen.getByRole('status', { name: 'Last restore failed' })).toBeInTheDocument()
  })
})

describe('Clear', () => {
  test('asks first, says what goes and what stays, and nothing is sent until it is confirmed', async () => {
    const api = section(overview({ restores: many(3) }), { 'DELETE /api/backups/volumes/a1/restores': { ...overview(), cleared: 3 } })
    await userEvent.click(await screen.findByRole('button', { name: 'Clear' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/The 3 finished restores listed here will be removed/)).toBeInTheDocument()
    expect(within(dialog).getByText(/the app's files and its backups are not touched/)).toBeInTheDocument()
    expect(api.called('DELETE', '/api/backups/volumes/a1/restores')).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.called('DELETE', '/api/backups/volumes/a1/restores')).toHaveLength(0)
  })
  test('confirming empties the list and says how many went', async () => {
    const api = section(overview({ restores: many(3) }), { 'DELETE /api/backups/volumes/a1/restores': { ...overview(), cleared: 3 } })
    await userEvent.click(await screen.findByRole('button', { name: 'Clear' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Clear the history' }))
    await waitFor(() => expect(api.called('DELETE', '/api/backups/volumes/a1/restores')).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('3 restores cleared from the history'))
    await waitFor(() => expect(screen.queryByText('Restores')).toBeNull())
  })
  test('the count counts only the finished ones: a restore that is running is not in it and has no part in Clear', async () => {
    section(overview({ restores: [restore(1, { status: 'running', finishedAt: null }), restore(2), restore(3, { status: 'failed', error: 'x' })] }))
    await userEvent.click(await screen.findByRole('button', { name: 'Clear' }))
    expect(within(await screen.findByRole('alertdialog')).getByText(/The 2 finished restores/)).toBeInTheDocument()
  })
  test('there is no Clear while nothing has finished', async () => {
    section(overview({ restores: [restore(1, { status: 'queued', finishedAt: null })] }))
    await screen.findByText('(1)')
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })
  test('a refusal is said and the list stays', async () => {
    section(overview({ restores: many(2) }), { 'DELETE /api/backups/volumes/a1/restores': answer(500, { error: 'boom' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Clear' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Clear the history' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalled())
    expect(items()).toHaveLength(2)
  })
})
