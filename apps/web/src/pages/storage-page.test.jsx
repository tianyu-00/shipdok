import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StoragePage from './storage-page'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { makeApp, APP_ID } from '@/test/fixtures'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const MB = 1024 * 1024
const storage = (over = {}) => ({
  logs: { totalBytes: 3 * MB, apps: [{ appId: APP_ID, slug: 'my-app', bytes: 3 * MB, files: 4 }] },
  images: { totalBytes: 100 * MB, apps: [{ appId: APP_ID, slug: 'my-app', images: 2, bytes: 100 * MB }] },
  disk: { totalBytes: 100 * 1024 * MB, freeBytes: 60 * 1024 * MB, freePercent: 60, level: 'ok' },
  ...over,
})
const routes = (over = {}) => ({ 'GET /api/storage': storage(), 'GET /api/apps': [makeApp()], ...over })
const page = () => renderWithProviders(<StoragePage />, { route: '/storage' })

describe('the storage page', () => {
  test('shows the disk and what each app takes', async () => {
    mockApi(routes())
    page()
    expect(await screen.findByText('Plenty of space')).toBeInTheDocument()
    expect(screen.getByText(/60\.0 GB free of 100 GB \(60% free\)/)).toBeInTheDocument()
    const row = (await screen.findByRole('link', { name: 'My App' })).closest('tr')
    expect(within(row).getByText(/3\.0 MB/)).toBeInTheDocument()
    expect(within(row).getByText(/4 files/)).toBeInTheDocument()
    expect(within(row).getByText(/100 MB/)).toBeInTheDocument()
    expect(within(row).getByText(/2 images/)).toBeInTheDocument()
    expect(within(row).getByText('103 MB')).toBeInTheDocument()
  })

  test('the bar shows how much is used, and turns red when the disk is almost full', async () => {
    mockApi(routes({ 'GET /api/storage': storage({ disk: { totalBytes: 100 * MB, freeBytes: 8 * MB, freePercent: 8, level: 'critical' } }) }))
    page()
    const bar = await screen.findByRole('img', { name: '92% used' })
    expect(bar.firstChild).toHaveStyle({ width: '92%' })
    expect(bar.firstChild.className).toMatch(/bg-destructive/)
  })

  test('the bar is the normal colour when there is plenty of space', async () => {
    mockApi(routes())
    page()
    const bar = await screen.findByRole('img', { name: '40% used' })
    expect(bar.firstChild.className).toMatch(/bg-primary/)
  })

  test.each([['low', 'Getting full'], ['critical', 'Almost full']])('a %s disk is labelled', async (level, label) => {
    mockApi(routes({ 'GET /api/storage': storage({ disk: { totalBytes: 100 * MB, freeBytes: 5 * MB, freePercent: 5, level } }) }))
    page()
    expect(await screen.findByText(label)).toBeInTheDocument()
  })

  test('nothing stored yet', async () => {
    mockApi(routes({ 'GET /api/storage': storage({ logs: { totalBytes: 0, apps: [] }, images: { totalBytes: 0, apps: [] } }) }))
    page()
    expect(await screen.findByText('Nothing stored yet')).toBeInTheDocument()
  })

  test('a load failure can be retried', async () => {
    mockApi(routes({ 'GET /api/storage': answer(500, { error: 'x' }) }))
    page()
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  test('links to the app\'s images', async () => {
    mockApi(routes())
    page()
    expect(await screen.findByRole('link', { name: 'Images' })).toHaveAttribute('href', `/apps/${APP_ID}/images`)
  })
})

describe('deleting an app\'s output logs', () => {
  const open = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Delete output logs' }))
    return screen.findByRole('alertdialog')
  }

  test('asks first, then deletes that app\'s logs', async () => {
    const api = mockApi(routes({ [`DELETE /api/apps/${APP_ID}/logs`]: { freedBytes: 3 * MB } }))
    page()
    const dialog = await open()
    expect(dialog).toHaveTextContent(/removed for good/)
    expect(api.called('DELETE', `/api/apps/${APP_ID}/logs`)).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.called('DELETE', `/api/apps/${APP_ID}/logs`)).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Deleted the output logs (3.0 MB)'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  test('cancel sends nothing', async () => {
    const api = mockApi(routes())
    page()
    await userEvent.click(within(await open()).getByRole('button', { name: 'Cancel' }))
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  test('a running app\'s refusal is shown', async () => {
    mockApi(routes({ [`DELETE /api/apps/${APP_ID}/logs`]: answer(409, { error: 'The app is running and its output is still being collected; stop it first' }) }))
    page()
    await userEvent.click(within(await open()).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/stop it first/)))
  })

  test('is not offered for an app with no logs', async () => {
    mockApi(routes({ 'GET /api/storage': storage({ logs: { totalBytes: 0, apps: [] } }) }))
    page()
    await screen.findByRole('link', { name: 'My App' })
    expect(screen.queryByRole('button', { name: 'Delete output logs' })).toBeNull()
  })
})
