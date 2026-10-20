import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsTab from './settings-tab'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { makeApp, makeVolume, APP_ID } from '@/test/fixtures'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const DELETE = `DELETE /api/apps/${APP_ID}`
const open = async () => {
  renderWithProviders(<SettingsTab app={makeApp()} />)
  await userEvent.click(screen.getByRole('button', { name: /delete app…/i }))
  return screen.findByRole('dialog')
}

describe('deleting an app', () => {
  test('the danger zone says what goes and what stays', () => {
    renderWithProviders(<SettingsTab app={makeApp()} />)
    expect(screen.getByText(/removes all its images, and deletes its logs, variables and deployment history/i)).toBeInTheDocument()
    expect(screen.getByText(/repository is not touched/i)).toBeInTheDocument()
  })

  test('needs the exact name typed, then sends it', async () => {
    const api = mockApi({ [DELETE]: answer(202, { deleting: true }) })
    const dialog = await open()
    const confirm = within(dialog).getByRole('button', { name: 'Delete app' })
    expect(confirm).toBeDisabled()
    const box = within(dialog).getByLabelText(/to confirm/i)
    for (const wrong of ['my app', 'My App ', 'My', 'my-app']) {
      await userEvent.clear(box); await userEvent.type(box, wrong)
      expect(confirm).toBeDisabled()
    }
    await userEvent.clear(box); await userEvent.type(box, 'My App')
    expect(confirm).toBeEnabled()
    expect(api.called('DELETE', `/api/apps/${APP_ID}`)).toHaveLength(0)
    await userEvent.click(confirm)
    await waitFor(() => expect(api.called('DELETE', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(api.called('DELETE', `/api/apps/${APP_ID}`)[0].body).toEqual({ confirm: 'My App' })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Deleting My App…'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('Enter deletes only once the name matches', async () => {
    const api = mockApi({ [DELETE]: answer(202, { deleting: true }) })
    const box = within(await open()).getByLabelText(/to confirm/i)
    await userEvent.type(box, 'nope{Enter}')
    expect(api.called('DELETE', `/api/apps/${APP_ID}`)).toHaveLength(0)
    await userEvent.clear(box); await userEvent.type(box, 'My App{Enter}')
    await waitFor(() => expect(api.called('DELETE', `/api/apps/${APP_ID}`)).toHaveLength(1))
  })

  test('cancel sends nothing, and the typed name is forgotten', async () => {
    const api = mockApi({})
    const dialog = await open()
    await userEvent.type(within(dialog).getByLabelText(/to confirm/i), 'My App')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: /delete app…/i }))
    expect(within(await screen.findByRole('dialog')).getByLabelText(/to confirm/i)).toHaveValue('')
  })

  test('a refusal (a deployment is running) is shown and the dialog stays', async () => {
    mockApi({ [DELETE]: answer(409, { error: 'A deployment is still running. Cancel it first.', code: 'deployment_active' }) })
    const dialog = await open()
    await userEvent.type(within(dialog).getByLabelText(/to confirm/i), 'My App')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete app' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('A deployment is still running. Cancel it first.'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('deleting an app that has persistent storage', () => {
  const VOLUMES = `GET /api/apps/${APP_ID}/volumes`
  const openWith = async (volumes) => {
    const api = mockApi({ [VOLUMES]: { volumes }, [DELETE]: answer(202, { deleting: true }) })
    renderWithProviders(<SettingsTab app={makeApp()} />)
    await userEvent.click(screen.getByRole('button', { name: /delete app…/i }))
    return { api, dialog: await screen.findByRole('dialog') }
  }
  const confirm = async (dialog) => {
    await userEvent.type(within(dialog).getByLabelText(/to confirm/i), 'My App')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete app' }))
  }

  test('says the data is KEPT by default, and nothing extra is sent', async () => {
    const { api, dialog } = await openWith([makeVolume({ path: '/data' }), makeVolume({ id: 'v2', path: '/uploads', state: 'detached' })])
    expect(await within(dialog).findByText(/2 volumes/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/kept/i)).toBeInTheDocument()
    const box = within(dialog).getByRole('checkbox', { name: /permanently delete/i })
    expect(box).not.toBeChecked()
    await confirm(dialog)
    await waitFor(() => expect(api.called('DELETE', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(api.called('DELETE', `/api/apps/${APP_ID}`)[0].body).toEqual({ confirm: 'My App' })
  })

  test('ticking the box sends the explicit choice, with a plain warning next to it', async () => {
    const { api, dialog } = await openWith([makeVolume({ path: '/data' })])
    const box = await within(dialog).findByRole('checkbox', { name: /permanently delete/i })
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument()
    await userEvent.click(box)
    await confirm(dialog)
    await waitFor(() => expect(api.called('DELETE', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(api.called('DELETE', `/api/apps/${APP_ID}`)[0].body).toEqual({ confirm: 'My App', deleteVolumes: true })
  })

  test('an app with no storage gets no such question', async () => {
    const { dialog } = await openWith([])
    await new Promise((r) => setTimeout(r, 30))
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
  })
})
