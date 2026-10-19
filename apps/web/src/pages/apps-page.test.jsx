import { describe, test, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Routes, Route } from 'react-router-dom'
import AppsPage from './apps-page'
import { mockApi, renderWithProviders } from '@/test/utils'
import { makeApp } from '@/test/fixtures'

const page = () => renderWithProviders(<Routes><Route path="/" element={<AppsPage />} /><Route path="/apps/new" element={<p>create page</p>} /></Routes>)

describe('the apps list', () => {
  test('shows each app with its repository, branch, runtime state and latest deployment', async () => {
    mockApi({ 'GET /api/apps': [makeApp()], 'GET /api/storage': { disk: { level: 'ok' } } })
    page()
    const link = await screen.findByRole('link', { name: 'My App' })
    const card = link.closest('[data-slot="card"]')
    expect(within(card).getByText('owner/my-app')).toBeInTheDocument()
    expect(within(card).getByText('main')).toBeInTheDocument()
    expect(within(card).getByText('Running')).toBeInTheDocument()
    expect(within(card).getByText('Successful')).toBeInTheDocument()
    expect(within(card).getByText('aaaaaaa')).toBeInTheDocument()
    expect(link).toHaveAttribute('href', `/apps/${makeApp().id}`)
  })

  test('the app\'s own address uses the host the dashboard is open on', async () => {
    mockApi({ 'GET /api/apps': [makeApp({ host_port: 9123 })], 'GET /api/storage': {} })
    page()
    const open = await screen.findByRole('link', { name: /open the app/i })
    expect(open).toHaveAttribute('href', `http://${window.location.hostname}:9123`)
  })

  test('deployment status and runtime state are separate things: a failed latest deployment next to a running app', async () => {
    mockApi({ 'GET /api/apps': [makeApp({ latest_deployment: { id: 'x', status: 'failed', commit_sha: 'c'.repeat(40), queued_at: '2026-10-19T11:00:00Z', finished_at: null } })], 'GET /api/storage': {} })
    page()
    await screen.findByText('Failed')
    expect(screen.getByText('Running')).toBeInTheDocument()
  })

  test('an app stopped on purpose says so', async () => {
    mockApi({ 'GET /api/apps': [makeApp({ desired_state: 'stopped', runtime: { state: 'stopped' } })], 'GET /api/storage': {} })
    page()
    expect(await screen.findByText('Stopped on purpose')).toBeInTheDocument()
  })

  test('a Stop that the worker has not carried out yet shows "Stopping…", not a calm "Running"', async () => {
    mockApi({ 'GET /api/apps': [makeApp({ desired_state: 'stopped', runtime: { state: 'running' } })], 'GET /api/storage': {} })
    page()
    expect(await screen.findByText('Stopping…')).toBeInTheDocument()
    expect(screen.queryByText('Running')).toBeNull()
  })

  test('an app that was never deployed has no runtime yet and no deployment', async () => {
    mockApi({ 'GET /api/apps': [makeApp({ runtime: null, latest_deployment: null })], 'GET /api/storage': {} })
    page()
    expect(await screen.findByText('Not started')).toBeInTheDocument()
    expect(screen.getByText('Never deployed')).toBeInTheDocument()
  })

  test.each([['crashed', 'Crashed'], ['unhealthy', 'Unhealthy'], ['restarting', 'Restarting']])('%s apps are labelled', async (state, label) => {
    mockApi({ 'GET /api/apps': [makeApp({ runtime: { state } })], 'GET /api/storage': {} })
    page()
    expect(await screen.findByText(label)).toBeInTheDocument()
  })

  test('no apps: a friendly empty state, and the way to create one', async () => {
    mockApi({ 'GET /api/apps': [], 'GET /api/storage': {} })
    page()
    expect(await screen.findByText('No apps yet')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('link', { name: /new app/i }))
    expect(await screen.findByText('create page')).toBeInTheDocument()
  })

  test('a failure to load says why and offers to try again', async () => {
    let fail = true
    mockApi({ 'GET /api/apps': () => { if (fail) throw { status: 500, body: { error: 'Internal server error' } }; return [makeApp()] }, 'GET /api/storage': {} })
    page()
    expect(await screen.findByText('Could not load your apps')).toBeInTheDocument()
    expect(screen.getByText('Internal server error')).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('link', { name: 'My App' })).toBeInTheDocument()
  })
})

describe('the storage warning', () => {
  test.each([
    ['low', /getting full/i, 'consider pruning'],
    ['critical', /almost full/i, 'held back'],
  ])('%s', async (level, title, hint) => {
    mockApi({ 'GET /api/apps': [], 'GET /api/storage': { disk: { level, freePercent: 7, freeBytes: 7e9, totalBytes: 100e9 } } })
    page()
    expect(await screen.findByText(title)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(hint, 'i'))).toBeInTheDocument()
    expect(screen.getByText(/7% free/)).toBeInTheDocument()
  })

  test('nothing is shown while there is plenty of space, or when the disk could not be measured', async () => {
    mockApi({ 'GET /api/apps': [makeApp()], 'GET /api/storage': { disk: { level: 'ok', freePercent: 60 } } })
    const { unmount } = page()
    await screen.findByRole('link', { name: 'My App' })
    expect(screen.queryByText(/disk/i)).toBeNull()
    unmount()
    mockApi({ 'GET /api/apps': [makeApp()], 'GET /api/storage': { disk: null } })
    page()
    await screen.findByRole('link', { name: 'My App' })
    expect(screen.queryByText(/disk/i)).toBeNull()
  })
})

describe('an app that is being deleted', () => {
  test('shows Deleting… and no link to open it', async () => {
    mockApi({ 'GET /api/apps': [makeApp({ deleting_at: '2026-10-19T12:00:00Z', desired_state: 'stopped' })], 'GET /api/storage': { disk: { level: 'ok' } } })
    renderWithProviders(<AppsPage />)
    expect(await screen.findByText('Deleting…')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /open the app/i })).toBeNull()
    expect(screen.queryByText('Stopped on purpose')).toBeNull()
  })
  test('a failed deletion is marked', async () => {
    mockApi({ 'GET /api/apps': [makeApp({ deleting_at: '2026-10-19T12:00:00Z', delete_error: 'x' })], 'GET /api/storage': { disk: { level: 'ok' } } })
    renderWithProviders(<AppsPage />)
    expect(await screen.findByText('Delete failed')).toBeInTheDocument()
  })
})
