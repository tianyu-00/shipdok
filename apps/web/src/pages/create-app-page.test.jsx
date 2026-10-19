import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Routes, Route } from 'react-router-dom'
import CreateAppPage from './create-app-page'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const page = () => renderWithProviders(<Routes><Route path="/apps/new" element={<CreateAppPage />} /><Route path="/apps/:id" element={<p>detail page</p>} /></Routes>, { route: '/apps/new' })
const repos = { repos: [{ fullName: 'tianyu-00/site', private: true, defaultBranch: 'trunk' }, { fullName: 'tianyu-00/api', private: false, defaultBranch: 'main' }] }

describe('creating an app', () => {
  test('sends exactly what was entered, as numbers where they are numbers, and opens the new app', async () => {
    const api = mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await userEvent.type(screen.getByLabelText('GitHub repository'), 'tianyu-00/site')
    await userEvent.type(screen.getByLabelText('Host port'), '9301')
    await userEvent.type(screen.getByLabelText('Health check path'), '/health')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body).toEqual({
      name: 'site', repo: 'tianyu-00/site', branch: 'trunk', root_dir: '.', container_port: 3000, host_port: 9301, health_path: '/health',
      memory_mb: 512, cpus: 1, max_restarts: 5, keep_previous_images: 1, auto_prune: false,
    })
  })

  test('picking a repository fills in the name and the repository\'s own default branch, unless the name was typed by hand', async () => {
    mockApi({ 'GET /api/github/repos': repos })
    page()
    await waitFor(() => expect(document.querySelectorAll('#repo-list option')).toHaveLength(2))
    await userEvent.type(screen.getByLabelText('GitHub repository'), 'tianyu-00/site')
    expect(screen.getByLabelText('Name')).toHaveValue('site')
    expect(screen.getByLabelText('Branch')).toHaveValue('trunk')
  })

  test('a name typed by hand is not overwritten', async () => {
    mockApi({ 'GET /api/github/repos': repos })
    page()
    await userEvent.type(screen.getByLabelText('Name'), 'Mine')
    await userEvent.type(screen.getByLabelText('GitHub repository'), 'tianyu-00/site')
    expect(screen.getByLabelText('Name')).toHaveValue('Mine')
  })

  test('without a GitHub App the repository is simply typed, and the form still works', async () => {
    const api = mockApi({ 'GET /api/github/repos': answer(501, { error: 'GitHub App is not configured' }), 'POST /api/apps': answer(201, { id: 'x', name: 'pub' }) })
    page()
    expect(await screen.findByText(/private repositories need the shipdok github app/i)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('GitHub repository'), 'someone/pub')
    await userEvent.type(screen.getByLabelText('Host port'), '9400')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    await waitFor(() => expect(api.called('POST', '/api/apps')).toHaveLength(1))
    expect(api.called('POST', '/api/apps')[0].body).toMatchObject({ repo: 'someone/pub', name: 'pub', branch: 'main', host_port: 9400 })
  })

  test('the server\'s reasons are shown next to the form and nothing navigates away', async () => {
    mockApi({
      'GET /api/github/repos': repos,
      'POST /api/apps': answer(400, { error: 'Invalid app settings', details: ['host_port: Too small: expected number to be >=1024'] }),
    })
    page()
    await userEvent.type(screen.getByLabelText('GitHub repository'), 'a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '80')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Invalid app settings')
    expect(alert).toHaveTextContent('host_port')
    expect(screen.queryByText('detail page')).toBeNull()
  })

  test('a taken port or name is shown as the server says it', async () => {
    mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': answer(409, { error: 'That host port is already assigned to another app' }) })
    page()
    await userEvent.type(screen.getByLabelText('GitHub repository'), 'a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '8080')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already assigned')
  })

  test('a warning from the server (the GitHub App is not installed on the repository) is shown but does not stop you', async () => {
    mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': answer(201, { id: 'x', name: 'site', warning: 'The Shipdok GitHub App is not installed on this repository.' }) })
    page()
    await userEvent.type(screen.getByLabelText('GitHub repository'), 'a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '9000')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(toasts.warning).toHaveBeenCalledWith(expect.stringMatching(/not installed/), expect.anything())
  })

  test('the clean-up choices are sent', async () => {
    const api = mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': answer(201, { id: 'x', name: 'n' }) })
    page()
    await userEvent.type(screen.getByLabelText('GitHub repository'), 'a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '9000')
    await userEvent.click(screen.getByText('Limits and clean-up'))
    await userEvent.clear(screen.getByLabelText('Earlier versions kept'))
    await userEvent.type(screen.getByLabelText('Earlier versions kept'), '3')
    await userEvent.click(screen.getByRole('switch'))
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    await waitFor(() => expect(api.called('POST', '/api/apps')).toHaveLength(1))
    expect(api.called('POST', '/api/apps')[0].body).toMatchObject({ keep_previous_images: 3, auto_prune: true })
  })

  test('the button is disabled while the request is running, so it cannot be sent twice', async () => {
    let release
    const api = mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': () => new Promise((r) => { release = () => r({ id: 'x', name: 'n' }) }) })
    page()
    await userEvent.type(screen.getByLabelText('GitHub repository'), 'a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '9000')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled()
    expect(api.called('POST', '/api/apps')).toHaveLength(1)
    release()
  })
})
