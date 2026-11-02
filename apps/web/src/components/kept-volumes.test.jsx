// The Storage page's card of volumes kept without an app, and Reclaim: attaching one, as it is, to an app at a path.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import KeptVolumes from './kept-volumes'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

const vol = (over = {}) => ({ id: 'k1', path: '/app/data/whatisthis', state: 'orphaned', dockerName: 'shipdok-vol-k1', appId: null, appName: 'Old blog', createdAt: '2026-10-01T10:00:00Z', stateChangedAt: '2026-10-20T10:00:00Z', removeError: null, sizeBytes: 2048, measuredAt: null, ...over })
const apps = [{ id: 'a2', name: 'Shop', deleting_at: null }, { id: 'a1', name: 'Blog', deleting_at: null }, { id: 'a3', name: 'Going', deleting_at: '2026-10-22T10:00:00Z' }]
const page = (extra = {}, kept = [vol()]) => { const api = mockApi({ 'GET /api/volumes': { volumes: kept }, 'GET /api/apps': apps, 'GET /api/apps/a1/volumes': { volumes: [] }, 'GET /api/apps/a2/volumes': { volumes: [{ id: 'x', path: '/data', state: 'in_use' }, { id: 'y', path: '/old', state: 'detached' }] }, ...extra }); renderWithProviders(<KeptVolumes />); return api }
const open = async (extra) => { const api = page(extra); await userEvent.click(await screen.findByRole('button', { name: 'Reclaim' })); return api }
const POST = 'POST /api/volumes/k1/reclaim'
const post = (api) => api.called('POST', '/api/volumes/k1/reclaim')

describe('the card', () => {
  test('has a Reclaim button beside Delete on each kept volume, and says what it does', async () => {
    page()
    expect(await screen.findByRole('button', { name: 'Reclaim' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.getByText(/Reclaim attaches a volume, with its data as it is, to an app/)).toBeInTheDocument()
  })
})

describe('the reclaim dialog', () => {
  test('says what happens (nothing is copied, mounted from the next deployment), offers the apps alphabetically without one being deleted, and starts with the old path', async () => {
    await open()
    expect(await screen.findByText('Reclaim this volume')).toBeInTheDocument()
    expect(screen.getByText(/Nothing is copied/)).toBeInTheDocument()
    expect(screen.getByText('next deployment')).toBeInTheDocument()
    expect([...screen.getByLabelText('Attach it to').options].map((o) => o.textContent)).toEqual(['Choose an app…', 'Blog', 'Shop'])
    expect(screen.getByLabelText(/Mount it at/)).toHaveValue('/app/data/whatisthis')
    expect(screen.getByRole('button', { name: 'Reclaim', hidden: false })).toBeDisabled()
  })
  test('sends the app and the path, then says to deploy the app and closes', async () => {
    const api = await open({ [POST]: answer(200, { volume: vol({ state: 'in_use' }) }) })
    await userEvent.selectOptions(await screen.findByLabelText('Attach it to'), 'a1')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reclaim' }))
    await waitFor(() => expect(post(api)).toHaveLength(1))
    expect(post(api)[0].body).toEqual({ appId: 'a1', path: '/app/data/whatisthis' })
    expect(toasts.success).toHaveBeenCalledWith('/app/data/whatisthis is attached to Blog. Deploy Blog to mount it.')
    await waitFor(() => expect(screen.queryByText('Reclaim this volume')).toBeNull())
  })
  test('the path can be changed, and is sent tidied', async () => {
    const api = await open({ [POST]: answer(200, { volume: vol() }) })
    await userEvent.selectOptions(await screen.findByLabelText('Attach it to'), 'a1')
    await userEvent.clear(screen.getByLabelText(/Mount it at/))
    await userEvent.type(screen.getByLabelText(/Mount it at/), ' //var//lib/files/ ')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reclaim' }))
    await waitFor(() => expect(post(api)).toHaveLength(1))
    expect(post(api)[0].body.path).toBe('/var/lib/files')
  })
  test('a path that is not usable is said at once and cannot be sent', async () => {
    await open()
    await userEvent.selectOptions(await screen.findByLabelText('Attach it to'), 'a1')
    await userEvent.clear(screen.getByLabelText(/Mount it at/))
    await userEvent.type(screen.getByLabelText(/Mount it at/), 'data')
    expect(await screen.findByText(/is not an absolute path/)).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reclaim' })).toBeDisabled()
  })
  test('a path the chosen app already keeps is said, and cannot be sent; a detached one of its own does not count', async () => {
    await open()
    await userEvent.selectOptions(await screen.findByLabelText('Attach it to'), 'a2')
    await userEvent.clear(screen.getByLabelText(/Mount it at/))
    await userEvent.type(screen.getByLabelText(/Mount it at/), '/data')
    expect(await screen.findByText('Shop already keeps /data. Choose another path.')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reclaim' })).toBeDisabled()
    await userEvent.clear(screen.getByLabelText(/Mount it at/))
    await userEvent.type(screen.getByLabelText(/Mount it at/), '/old')
    await waitFor(() => expect(screen.queryByText(/already keeps/)).toBeNull())
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reclaim' })).toBeEnabled()
  })
  test('warns about the folder an app\'s code usually lives in, but does not block it', async () => {
    await open()
    await userEvent.selectOptions(await screen.findByLabelText('Attach it to'), 'a1')
    await userEvent.clear(screen.getByLabelText(/Mount it at/))
    await userEvent.type(screen.getByLabelText(/Mount it at/), '/app')
    expect(await screen.findByRole('status', { name: 'Code folder' })).toHaveTextContent(/probably the folder your app's code lives in/)
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reclaim' })).toBeEnabled()
  })
  test('the server\'s refusal is shown in the dialog, which stays open', async () => {
    await open({ [POST]: answer(409, { error: 'Blog already keeps /x. Choose another path, or remove it from that app first', code: 'path_in_use' }) })
    await userEvent.selectOptions(await screen.findByLabelText('Attach it to'), 'a1')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reclaim' }))
    expect(await screen.findByText(/Blog already keeps \/x/)).toBeInTheDocument()
    expect(screen.getByText('Reclaim this volume')).toBeInTheDocument()
  })
  test('cancelling sends nothing', async () => {
    const api = await open()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(post(api)).toHaveLength(0)
  })
  test('says so when there is no app to attach it to', async () => {
    await open({ 'GET /api/apps': [] })
    expect(await screen.findByText('There is no app yet. Create one first.')).toBeInTheDocument()
    expect(screen.getByLabelText('Attach it to')).toBeDisabled()
  })
})
