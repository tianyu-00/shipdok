import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsTab from './settings-tab'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { makeApp, APP_ID } from '@/test/fixtures'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const PUT = `PUT /api/apps/${APP_ID}`
const tab = (app = makeApp()) => renderWithProviders(<SettingsTab app={app} />)
const box = (label) => screen.getByLabelText(label)
const save = () => screen.getByRole('button', { name: 'Save' })
const type = async (label, text) => { await userEvent.clear(box(label)); if (text) await userEvent.type(box(label), text) }

describe('persistent storage on the settings tab', () => {
  test('has its own card, between the settings and the danger zone', async () => {
    mockApi({ [`GET /api/apps/${APP_ID}/volumes`]: { volumes: [] } })
    tab()
    const card = await screen.findByText('Persistent storage')
    const del = screen.getByText('Delete this app')
    expect(card.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('the build time limit', () => {
  test('is an empty box when there is no limit, and says what that means', () => {
    tab(makeApp({ build_timeout_minutes: null }))
    expect(box('Build time limit (minutes)')).toHaveValue('')
    expect(screen.getByText(/leave empty for no limit/i)).toBeInTheDocument()
    expect(screen.getByText(/blocks? (the )?other deployments|until you cancel/i)).toBeInTheDocument()
  })

  test('setting it sends the number, and it waits for the next deployment', async () => {
    const api = mockApi({ [PUT]: makeApp({ build_timeout_minutes: 60, settings_pending: ['build_timeout_minutes'] }) })
    tab()
    await type('Build time limit (minutes)', '60')
    await userEvent.click(save())
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(api.called('PUT', `/api/apps/${APP_ID}`)[0].body).toEqual({ build_timeout_minutes: 60 })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Saved. Deploy to apply the changes.'))
  })

  test('emptying it sends null (no limit)', async () => {
    const api = mockApi({ [PUT]: makeApp({ build_timeout_minutes: null, settings_pending: ['build_timeout_minutes'] }) })
    tab(makeApp({ build_timeout_minutes: 45 }))
    expect(box('Build time limit (minutes)')).toHaveValue('45')
    await type('Build time limit (minutes)', '')
    await userEvent.click(save())
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(api.called('PUT', `/api/apps/${APP_ID}`)[0].body).toEqual({ build_timeout_minutes: null })
  })

  test('a number the server would refuse is caught first', async () => {
    const api = mockApi({})
    tab()
    await type('Build time limit (minutes)', '3')
    await userEvent.click(save())
    expect(await screen.findByText(/from 5 to 10080/i)).toBeInTheDocument()
    expect(box('Build time limit (minutes)')).toHaveAttribute('aria-invalid', 'true')
    expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(0)
  })
})

describe('the settings form', () => {
  test('starts with the app\'s values, and nothing to save', () => {
    tab(makeApp({ health_path: null, cpus: '1.50' }))
    expect(box('Name')).toHaveValue('My App')
    expect(box('Host port')).toHaveValue('8080')
    expect(box('Health check path')).toHaveValue('')
    expect(box('CPU limit')).toHaveValue('1.5')
    expect(save()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled()
  })

  test('the repository is shown as a link and cannot be edited, with the way to change it', () => {
    tab()
    expect(screen.getByRole('link', { name: 'owner/my-app' })).toHaveAttribute('href', 'https://github.com/owner/my-app')
    expect(screen.queryByLabelText(/repository/i)).toBeNull()
    expect(screen.getByText(/delete this app and create a new one/i)).toBeInTheDocument()
  })

  test('sends only what changed, and says deploying is needed', async () => {
    const api = mockApi({ [PUT]: makeApp({ host_port: 9000, settings_pending: ['host_port'] }) })
    tab()
    await type('Host port', '9000')
    expect(save()).toBeEnabled()
    await userEvent.click(save())
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(api.called('PUT', `/api/apps/${APP_ID}`)[0].body).toEqual({ host_port: 9000 })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Saved. Deploy to apply the changes.'))
  })

  test('an edit that applies at once just says Saved', async () => {
    mockApi({ [PUT]: makeApp({ name: 'Renamed', settings_pending: [] }) })
    tab()
    await type('Name', 'Renamed')
    await userEvent.click(save())
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Saved'))
  })

  test('emptying the health path sends null', async () => {
    const api = mockApi({ [PUT]: makeApp({ health_path: null }) })
    tab()
    await type('Health check path', '')
    await userEvent.click(save())
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}`)[0].body).toEqual({ health_path: null }))
  })

  test('a taken port is explained next to the port box, which keeps what was typed', async () => {
    mockApi({ [PUT]: answer(409, { error: 'Port 8081 is already used by the app "Other"', code: 'port_taken', app: { id: 'x', name: 'Other' } }) })
    tab()
    await type('Host port', '8081')
    await userEvent.click(save())
    const message = await screen.findByText('Port 8081 is already used by the app "Other"')
    expect(message).toHaveAttribute('role', 'alert')
    expect(box('Host port')).toHaveValue('8081')
    expect(box('Host port')).toHaveAttribute('aria-invalid', 'true')
    expect(toasts.error).not.toHaveBeenCalled()
  })

  test('the message goes away when the port is edited', async () => {
    mockApi({ [PUT]: answer(409, { error: 'Port 8081 is already used by the app "Other"', code: 'port_taken' }) })
    tab()
    await type('Host port', '8081')
    await userEvent.click(save())
    await screen.findByText(/already used by the app/)
    await userEvent.type(box('Host port'), '2')
    expect(screen.queryByText(/already used by the app/)).toBeNull()
  })

  test('a taken name is explained next to the name box', async () => {
    mockApi({ [PUT]: answer(409, { error: 'The name "Other" is already used by the app "Other"', code: 'name_taken' }) })
    tab()
    await type('Name', 'Other')
    await userEvent.click(save())
    expect(await screen.findByText(/The name "Other" is already used/)).toBeInTheDocument()
    expect(box('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(box('Host port')).not.toHaveAttribute('aria-invalid')
  })

  test('after saving the form shows what the server now has', async () => {
    mockApi({ [PUT]: makeApp({ name: 'Trimmed Name', updated_at: '2026-10-19T13:00:00Z', settings_pending: [] }) })
    const view = tab(makeApp({ updated_at: '2026-10-19T12:00:00Z' }))
    await type('Name', 'Trimmed   Name  ')
    await userEvent.click(save())
    await waitFor(() => expect(toasts.success).toHaveBeenCalled())
    view.rerender(view.wrap(<SettingsTab app={makeApp({ name: 'Trimmed Name', updated_at: '2026-10-19T13:00:00Z' })} />))
    expect(box('Name')).toHaveValue('Trimmed Name')
    expect(save()).toBeDisabled()
  })

  test('mistakes are caught in the browser: nothing is sent', async () => {
    const api = mockApi({ [PUT]: makeApp() })
    tab()
    await type('Host port', '80')
    await type('Memory limit (MB)', '10')
    await userEvent.click(save())
    expect(await screen.findByText(/1024 to 65535/)).toBeInTheDocument()
    expect(screen.getByText(/64 to 8192/)).toBeInTheDocument()
    expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(0)
  })

  test('other refusals from the server are shown (a list of problems, or a toast)', async () => {
    mockApi({ [PUT]: answer(400, { error: 'Invalid app settings', details: ['branch: Invalid branch name'] }) })
    tab()
    await type('Branch', 'dev')
    await userEvent.click(save())
    expect(await screen.findByText('branch: Invalid branch name')).toBeInTheDocument()
  })

  test('a server error that is not about a field is a toast', async () => {
    mockApi({ [PUT]: answer(500, { error: 'Internal server error' }) })
    tab()
    await type('Name', 'X')
    await userEvent.click(save())
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Internal server error'))
  })

  test('discard puts the saved values back', async () => {
    tab()
    await type('Host port', '9999')
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(box('Host port')).toHaveValue('8080')
    expect(save()).toBeDisabled()
  })

  test('explains that the host port moves with the next deployment', () => {
    tab()
    expect(screen.getByText(/takes effect with the next deployment/i)).toBeInTheDocument()
    expect(screen.getByText(/something else on this machine uses the port/i)).toBeInTheDocument()
  })
})

describe('edits that are waiting for a deployment', () => {
  test('are listed by name', () => {
    tab(makeApp({ settings_pending: ['host_port', 'memory_mb'] }))
    expect(screen.getByText('These settings are not in the running app yet')).toBeInTheDocument()
    expect(screen.getByText(/Host port, Memory limit/)).toBeInTheDocument()
  })
  test('nothing is shown when nothing waits (or nothing was deployed)', () => {
    tab(makeApp({ settings_pending: [] }))
    expect(screen.queryByText(/not in the running app yet/)).toBeNull()
  })
  test('a single one is called "it"', () => {
    tab(makeApp({ settings_pending: ['cpus'] }))
    expect(screen.getByText(/CPU limit\. Press Deploy to apply it\./)).toBeInTheDocument()
  })
})
