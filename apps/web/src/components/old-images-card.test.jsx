import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OldImagesCard from './old-images-card'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const MB = 1024 ** 2
const GB = 1024 ** 3
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const overview = (over = {}) => ({
  reclaimableBytes: 700 * MB,
  apps: [
    { appId: A, name: 'Alpha', slug: 'alpha', reclaimableBytes: 600 * MB, images: 3, autoCleanup: false },
    { appId: B, name: 'Beta', slug: 'beta', reclaimableBytes: 100 * MB, images: 1, autoCleanup: true },
    { appId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Gamma', slug: 'gamma', reclaimableBytes: 0, images: 0, autoCleanup: true },
  ],
  autoCleanup: { on: 2, total: 3 }, thresholdBytes: null, exceeded: false, ...over,
})
const card = () => renderWithProviders(<OldImagesCard />)

describe('the figures', () => {
  test('say how much could be freed, list the apps that have old images, and link to their Images tab', async () => {
    mockApi({ 'GET /api/images': overview() })
    card()
    expect(await screen.findByText(/About 700 MB could be freed in 2 apps/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Alpha' })).toHaveAttribute('href', `/apps/${A}/images`)
    expect(screen.getByText(/3 old images, up to 600 MB/)).toBeInTheDocument()
    expect(screen.getByText(/1 old image, up to 100 MB/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Gamma' })).toBeNull() // nothing old: not listed
  })

  test('with nothing old it says so, and still offers the clean-up (a clean-up also removes images of failed deployments)', async () => {
    mockApi({ 'GET /api/images': overview({ reclaimableBytes: 0, apps: overview().apps.map((a) => ({ ...a, reclaimableBytes: 0, images: 0 })) }) })
    card()
    expect(await screen.findByText('No old images.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clean up old images' })).toBeEnabled()
  })

  test('with no apps there is nothing to clean', async () => {
    mockApi({ 'GET /api/images': overview({ reclaimableBytes: 0, apps: [], autoCleanup: { on: 0, total: 0 } }) })
    card()
    expect(await screen.findByText('No old images.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clean up old images' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /every app/ })).toBeNull()
  })

  test('the amount is highlighted once it has reached the size the user set', async () => {
    mockApi({ 'GET /api/images': overview({ thresholdBytes: 500 * MB, exceeded: true }) })
    card()
    expect((await screen.findByText(/About 700 MB could be freed/)).closest('p')).toHaveClass('text-warning')
  })

  test('a failure to load is shown, with a way to try again', async () => {
    mockApi({ 'GET /api/images': answer(500, { error: 'boom' }) })
    card()
    expect(await screen.findByText('Could not load the old images')).toBeInTheDocument()
  })
})

describe('cleaning every app', () => {
  test('asks first, says what stays, and only then queues it', async () => {
    const api = mockApi({ 'GET /api/images': overview(), 'POST /api/images/prune': answer(202, { queued: 3, apps: 3 }) })
    card()
    await userEvent.click(await screen.findByRole('button', { name: 'Clean up old images' }))
    const dialog = within(await screen.findByRole('alertdialog'))
    expect(dialog.getByText(/keeps its live version and the earlier versions it is set to keep/)).toBeInTheDocument()
    expect(dialog.getByText(/can no longer be rolled back to/)).toBeInTheDocument()
    expect(api.called('POST', '/api/images/prune')).toHaveLength(0)
    await userEvent.click(dialog.getByRole('button', { name: 'Clean up' }))
    await waitFor(() => expect(api.called('POST', '/api/images/prune')).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Clean-up queued for 3 apps'))
    expect(await screen.findByRole('status')).toHaveTextContent('Cleaning…')
  })

  test('Cancel queues nothing', async () => {
    const api = mockApi({ 'GET /api/images': overview() })
    card()
    await userEvent.click(await screen.findByRole('button', { name: 'Clean up old images' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(api.called('POST', '/api/images/prune')).toHaveLength(0)
  })

  test('says so when only some apps could be queued, and when none exist', async () => {
    mockApi({ 'GET /api/images': overview(), 'POST /api/images/prune': answer(202, { queued: 1, apps: 3 }) })
    card()
    await userEvent.click(await screen.findByRole('button', { name: 'Clean up old images' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Clean up' }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Clean-up queued for 1 of 3 apps'))
  })

  test('a refusal is a toast, and no "Cleaning…" line is shown', async () => {
    mockApi({ 'GET /api/images': overview(), 'POST /api/images/prune': answer(503, { error: 'Could not queue the clean-up' }) })
    card()
    await userEvent.click(await screen.findByRole('button', { name: 'Clean up old images' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Clean up' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not queue the clean-up'))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('the automatic clean-up of every app', () => {
  test('says how many apps have it, and turns it on for all', async () => {
    const api = mockApi({ 'GET /api/images': overview(), 'POST /api/images/auto-cleanup': { enabled: true, changed: 1 } })
    card()
    expect(await screen.findByText(/is on for 2 of 3 apps\. New apps start with it on/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Turn on for every app' }))
    await waitFor(() => expect(api.called('POST', '/api/images/auto-cleanup')).toHaveLength(1))
    expect(api.called('POST', '/api/images/auto-cleanup')[0].body).toEqual({ enabled: true })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Automatic clean-up is on for every app'))
  })

  test('when every app has it, the button turns it off for all', async () => {
    const api = mockApi({ 'GET /api/images': overview({ autoCleanup: { on: 3, total: 3 } }), 'POST /api/images/auto-cleanup': { enabled: false, changed: 3 } })
    card()
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off for every app' }))
    await waitFor(() => expect(api.called('POST', '/api/images/auto-cleanup')[0].body).toEqual({ enabled: false }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Automatic clean-up is off for every app'))
  })

  test('with no apps at all there is nothing to switch', async () => {
    mockApi({ 'GET /api/images': overview({ apps: [], reclaimableBytes: 0, autoCleanup: { on: 0, total: 0 } }) })
    card()
    expect(await screen.findByText(/is on for 0 of 0 apps/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /every app/ })).toBeNull()
  })

  test('the apps\' own screens are told to look again', async () => {
    const api = mockApi({ 'GET /api/images': overview(), 'POST /api/images/auto-cleanup': { enabled: true, changed: 1 }, 'GET /api/apps': [] })
    card()
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on for every app' }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalled())
    await waitFor(() => expect(api.called('GET', '/api/images').length).toBeGreaterThan(1))
  })
})

describe('the size at which to be told', () => {
  test('starts empty (never) with the default explained, and Save is off while nothing changed', async () => {
    mockApi({ 'GET /api/images': overview() })
    card()
    const box = await screen.findByLabelText('Tell me when old images reach (GB)')
    expect(box).toHaveValue('')
    expect(box).toHaveAttribute('placeholder', 'never')
    expect(screen.getByText(/Empty means never, which is the default/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('shows the saved size in GB', async () => {
    mockApi({ 'GET /api/images': overview({ thresholdBytes: 2.5 * GB }) })
    card()
    expect(await screen.findByLabelText('Tell me when old images reach (GB)')).toHaveValue('2.5')
  })

  test('a size is sent in bytes', async () => {
    const api = mockApi({ 'GET /api/images': overview(), 'PUT /api/images/notice': overview({ thresholdBytes: 2 * GB }) })
    card()
    await userEvent.type(await screen.findByLabelText('Tell me when old images reach (GB)'), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.called('PUT', '/api/images/notice')).toHaveLength(1))
    expect(api.called('PUT', '/api/images/notice')[0].body).toEqual({ thresholdBytes: 2 * GB })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('You will be told when old images reach 2.0 GB'))
  })

  test('emptying the box sends null (never)', async () => {
    const api = mockApi({ 'GET /api/images': overview({ thresholdBytes: 2 * GB }), 'PUT /api/images/notice': overview() })
    card()
    const box = await screen.findByLabelText('Tell me when old images reach (GB)')
    await userEvent.clear(box)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.called('PUT', '/api/images/notice')[0].body).toEqual({ thresholdBytes: null }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('No notice about old images'))
  })

  test('a size the server would refuse is caught first, next to the box', async () => {
    const api = mockApi({ 'GET /api/images': overview() })
    card()
    const box = await screen.findByLabelText('Tell me when old images reach (GB)')
    await userEvent.type(box, '0.01')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/from 0\.1 to 10240/)).toBeInTheDocument()
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(api.called('PUT', '/api/images/notice')).toHaveLength(0)
    await userEvent.type(box, '5')
    expect(screen.queryByText(/from 0\.1 to 10240/)).toBeNull()
  })

  test('a refusal from the server is a toast', async () => {
    mockApi({ 'GET /api/images': overview(), 'PUT /api/images/notice': answer(400, { error: 'Invalid request' }) })
    card()
    await userEvent.type(await screen.findByLabelText('Tell me when old images reach (GB)'), '3')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Invalid request'))
  })
})
