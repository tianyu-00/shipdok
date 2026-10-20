import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BuildCacheCard from './build-cache-card'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const GB = 1024 ** 3
const MB = 1024 ** 2
const cache = (over = {}) => ({ totalBytes: 5 * GB, reclaimableBytes: 3 * GB, sampledAt: new Date(Date.now() - 120_000).toISOString(), cleaning: false, last: null, ...over })
const show = (data = cache(), more = {}) => {
  const api = mockApi({ 'GET /api/build-cache': data, ...more })
  renderWithProviders(<BuildCacheCard />)
  return api
}

describe('the figures', () => {
  test('shows the size, how much is not in use, and how old the measurement is', async () => {
    show()
    expect(await screen.findByText(/5\.0 GB in the cache, 3\.0 GB of it not in use/)).toBeInTheDocument()
    expect(screen.getByText(/Measured 2 min ago/)).toBeInTheDocument()
  })

  test('before the first measurement it says so instead of showing zero', async () => {
    show(cache({ totalBytes: null, reclaimableBytes: null, sampledAt: null }))
    expect(await screen.findByText(/Not measured yet/)).toBeInTheDocument()
    expect(screen.queryByText(/in the cache/)).toBeNull()
  })

  test('the last clean-up: what it was and what it freed', async () => {
    show(cache({ last: { at: new Date().toISOString(), all: false, freedBytes: 700 * MB, error: null } }))
    expect(await screen.findByText(/unused for a day\): 700 MB freed/)).toBeInTheDocument()
  })

  test('a failed clean-up shows why', async () => {
    show(cache({ last: { at: new Date().toISOString(), all: true, freedBytes: 0, error: 'daemon said no' } }))
    expect(await screen.findByText(/failed: daemon said no/)).toBeInTheDocument()
  })

  test('the card says what cleaning does not touch', async () => {
    show()
    expect(await screen.findByText(/no images, containers, volumes or logs/)).toBeInTheDocument()
  })

  test('while a clean-up runs the buttons are off and the card says so', async () => {
    show(cache({ cleaning: true }))
    expect(await screen.findByText(/Cleaning…/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clean unused cache' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Clean everything unused' })).toBeDisabled()
  })

  test('an error loading it is shown with a way to retry', async () => {
    mockApi({ 'GET /api/build-cache': answer(500, { error: 'boom' }) })
    renderWithProviders(<BuildCacheCard />)
    expect(await screen.findByText('Could not load the build cache')).toBeInTheDocument()
  })
})

describe('cleaning', () => {
  test.each([
    ['Clean unused cache', false, /24 hours/],
    ['Clean everything unused', true, /starts from nothing/],
  ])('"%s" asks first, then sends all=%s', async (button, all, warning) => {
    const api = show(undefined, { 'POST /api/build-cache/clean': answer(202, { queued: true }) })
    await userEvent.click(await screen.findByRole('button', { name: button }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(warning)).toBeInTheDocument()
    expect(api.called('POST', '/api/build-cache/clean')).toHaveLength(0) // nothing yet: only the question
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clean' }))
    await waitFor(() => expect(api.called('POST', '/api/build-cache/clean')).toHaveLength(1))
    expect(api.called('POST', '/api/build-cache/clean')[0].body).toEqual({ all })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Cleaning the build cache…'))
  })

  test('Cancel sends nothing', async () => {
    const api = show()
    await userEvent.click(await screen.findByRole('button', { name: 'Clean everything unused' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(api.called('POST', '/api/build-cache/clean')).toHaveLength(0)
  })

  test('the API\'s refusal (one is already running) is shown', async () => {
    show(undefined, { 'POST /api/build-cache/clean': answer(409, { error: 'A clean-up of the build cache is already waiting or running', code: 'already_queued' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Clean unused cache' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Clean' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('A clean-up of the build cache is already waiting or running'))
  })
})
