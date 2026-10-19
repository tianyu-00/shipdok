import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DeploymentsTab from './deployments-tab'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { makeApp, makeDeployment, APP_ID, line } from '@/test/fixtures'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const LIST = `GET /api/apps/${APP_ID}/deployments`
const tab = () => renderWithProviders(<DeploymentsTab app={makeApp()} />)
const rowOf = async (text) => (await screen.findByText(text)).closest('tr')

describe('the deployment history', () => {
  test('shows status, short commit, and how long each took', async () => {
    mockApi({ [LIST]: [makeDeployment({ id: 'a', status: 'successful', commit_sha: 'abcdef1234567890'.padEnd(40, '0'), started_at: '2026-10-19T11:50:00Z', finished_at: '2026-10-19T11:51:30Z' })] })
    tab()
    const row = await rowOf('Successful')
    expect(within(row).getByText('abcdef1')).toBeInTheDocument()
    expect(within(row).getByText('1m 30s')).toBeInTheDocument()
  })

  test('explains why a deployment did not succeed', async () => {
    mockApi({ [LIST]: [
      makeDeployment({ id: '1', status: 'failed', error_summary: 'docker exited 1' }),
      makeDeployment({ id: '2', status: 'superseded', error_summary: null }),
      makeDeployment({ id: '3', status: 'interrupted', error_summary: 'The worker stopped while this deployment was in progress' }),
    ] })
    tab()
    expect(await screen.findByText('docker exited 1')).toBeInTheDocument()
    expect(screen.getByText('Replaced by a newer deployment')).toBeInTheDocument()
    expect(screen.getByText(/worker stopped/)).toBeInTheDocument()
  })

  test('pushes and rollbacks are marked, manual ones are not', async () => {
    mockApi({ [LIST]: [makeDeployment({ id: '1', trigger: 'webhook' }), makeDeployment({ id: '2', trigger: 'rollback' }), makeDeployment({ id: '3', trigger: 'manual' })] })
    tab()
    expect(await screen.findByText('Push')).toBeInTheDocument()
    expect(screen.getByText('Rollback')).toBeInTheDocument()
    expect(screen.queryByText('Manual')).toBeNull()
  })

  test('no deployments yet', async () => {
    mockApi({ [LIST]: [] })
    tab()
    expect(await screen.findByText('No deployments yet')).toBeInTheDocument()
  })

  test('a load failure can be retried', async () => {
    mockApi({ [LIST]: answer(500, { error: 'Internal server error' }) })
    tab()
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
  })
})

describe('cancelling', () => {
  test('is offered only while a deployment is still going', async () => {
    mockApi({ [LIST]: [
      makeDeployment({ id: 'q', status: 'queued', commit_sha: '1'.repeat(40) }), makeDeployment({ id: 'b', status: 'building', commit_sha: '2'.repeat(40) }),
      makeDeployment({ id: 's', status: 'successful', commit_sha: '3'.repeat(40) }), makeDeployment({ id: 'f', status: 'failed', commit_sha: '4'.repeat(40) }),
    ] })
    tab()
    await screen.findByText('Queued')
    expect(screen.getAllByRole('button', { name: /cancel/i })).toHaveLength(2)
    expect(within(await rowOf('Successful')).queryByRole('button', { name: /cancel/i })).toBeNull()
    expect(within(await rowOf('Failed')).queryByRole('button', { name: /cancel/i })).toBeNull()
  })

  test('asks the API to cancel that deployment', async () => {
    const api = mockApi({ [LIST]: [makeDeployment({ id: 'dep-q', status: 'queued' })], 'POST /api/deployments/dep-q/cancel': makeDeployment({ id: 'dep-q', status: 'cancelled' }) })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(api.called('POST', '/api/deployments/dep-q/cancel')).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Cancelled'))
  })

  test('a running build is only asked to stop, and the message says so', async () => {
    mockApi({ [LIST]: [makeDeployment({ id: 'dep-b', status: 'building' })], 'POST /api/deployments/dep-b/cancel': answer(202, makeDeployment({ id: 'dep-b', status: 'building' })) })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Stop requested'))
  })

  test('a deployment that finished meanwhile is reported', async () => {
    mockApi({ [LIST]: [makeDeployment({ id: 'dep-b', status: 'building' })], 'POST /api/deployments/dep-b/cancel': answer(409, { error: 'This deployment has already finished' }) })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('This deployment has already finished'))
  })
})

describe('the build log', () => {
  test('opens in a window and reads that deployment\'s log', async () => {
    const api = mockApi({
      [LIST]: [makeDeployment({ id: 'dep-1' }), makeDeployment({ id: 'dep-2', commit_sha: 'c'.repeat(40) })],
      'GET /api/deployments/dep-2/logs': { text: line(1, 'shipdok', 'Cloning o/r@main'), offset: 0, nextOffset: 60, size: 60, complete: true, truncated: false },
    })
    tab()
    const row = await rowOf('ccccccc')
    await userEvent.click(within(row).getByRole('button', { name: /log/i }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Cloning o/r@main')).toBeInTheDocument()
    expect(api.calls.some((c) => c.bare === '/api/deployments/dep-2/logs')).toBe(true)
    expect(api.calls.some((c) => c.bare === '/api/deployments/dep-1/logs')).toBe(false)
  })

  test('a deployment whose log was deleted says so', async () => {
    mockApi({ [LIST]: [makeDeployment({ id: 'dep-1' })], 'GET /api/deployments/dep-1/logs': answer(404, { error: 'No log for this deployment' }) })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: /log/i }))
    expect(await screen.findByText(/may have been deleted/i)).toBeInTheDocument()
  })
})
