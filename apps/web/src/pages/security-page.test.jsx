import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SecurityPage from './security-page'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const NOW = Date.now()
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString()
const LOGINS = {
  logins: [
    { at: at(60), kind: 'login', username: 'admin', address: '::ffff:192.168.1.20', success: true },
    { at: at(3600), kind: 'login', username: 'root', address: '203.0.113.9', success: false },
    { at: at(7200), kind: 'recovery', username: 'admin', address: '203.0.113.9', success: true },
    { at: at(86400), kind: 'setup', username: 'admin', address: '::ffff:192.168.1.20', success: true },
    { at: at(90000), kind: 'reset', username: 'admin', address: 'host', success: true },
  ],
}
const page = () => renderWithProviders(<SecurityPage />, { route: '/security' })

describe('the security page', () => {
  test('lists recent sign-ins with when, who, from where and how it went', async () => {
    mockApi({ 'GET /api/auth/logins': LOGINS })
    page()
    const rows = await screen.findAllByRole('row')
    const body = rows.slice(1) // header row first
    expect(body).toHaveLength(5)
    expect(within(body[0]).getByText('Signed in')).toBeInTheDocument()
    expect(within(body[0]).getByText('admin')).toBeInTheDocument()
    expect(within(body[0]).getByText('192.168.1.20')).toBeInTheDocument() // the ::ffff: prefix is noise
    expect(within(body[0]).getByText('1 min ago')).toBeInTheDocument()
    expect(within(body[1]).getByText('Failed')).toBeInTheDocument()
    expect(within(body[1]).getByText('root')).toBeInTheDocument()
    expect(within(body[1]).getByText('203.0.113.9')).toBeInTheDocument()
    expect(within(body[2]).getByText('Recovery code used')).toBeInTheDocument()
    expect(within(body[3]).getByText('Account created')).toBeInTheDocument()
    expect(within(body[4]).getByText('Password reset on the host')).toBeInTheDocument()
  })

  test('names typed by strangers are shown as plain text', async () => {
    mockApi({ 'GET /api/auth/logins': { logins: [{ at: at(5), kind: 'login', username: '<img src=x onerror=alert(1)>', address: '1.2.3.4', success: false }] } })
    const { container } = page()
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })

  test('says so when there is nothing yet', async () => {
    mockApi({ 'GET /api/auth/logins': { logins: [] } })
    page()
    expect(await screen.findByText(/no sign-ins recorded/i)).toBeInTheDocument()
  })

  test('shows an error with a retry when the list cannot be loaded', async () => {
    mockApi({ 'GET /api/auth/logins': () => { throw { status: 500, body: { error: 'boom' } } }, 'GET /api/auth/recovery': { remaining: 10, createdAt: null } })
    page()
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  })

  test('is honest that there is no second login step', async () => {
    mockApi({ 'GET /api/auth/logins': LOGINS })
    page()
    expect(await screen.findByText(/no second login step|no two-factor/i)).toBeInTheDocument()
  })
})

describe('sign out everywhere', () => {
  test('asks first, and cancelling sends nothing', async () => {
    const api = mockApi({ 'GET /api/auth/logins': LOGINS, 'POST /api/auth/logout-all': null })
    page()
    await userEvent.click(await screen.findByRole('button', { name: /sign out everywhere/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(/this browser too/i)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.called('POST', '/api/auth/logout-all')).toHaveLength(0)
  })

  test('confirming ends the sessions and the dashboard returns to the login screen', async () => {
    const api = mockApi({ 'GET /api/auth/logins': LOGINS, 'POST /api/auth/logout-all': null })
    const { client } = page()
    client.setQueryData(['auth'], { authenticated: true, username: 'admin' })
    await userEvent.click(await screen.findByRole('button', { name: /sign out everywhere/i }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /sign out everywhere/i }))
    await waitFor(() => expect(api.called('POST', '/api/auth/logout-all')).toHaveLength(1))
    await waitFor(() => expect(client.getQueryData(['auth'])).toMatchObject({ authenticated: false }))
  })

  test('a failure is reported and the session stays', async () => {
    mockApi({ 'GET /api/auth/logins': LOGINS, 'POST /api/auth/logout-all': () => { throw { status: 500, body: { error: 'nope' } } } })
    const { client } = page()
    client.setQueryData(['auth'], { authenticated: true, username: 'admin' })
    await userEvent.click(await screen.findByRole('button', { name: /sign out everywhere/i }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /sign out everywhere/i }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('nope'))
    expect(client.getQueryData(['auth'])).toMatchObject({ authenticated: true })
  })
})

describe('change password from here', () => {
  test('opens the same dialog as the header key', async () => {
    mockApi({ 'GET /api/auth/logins': LOGINS })
    page()
    await userEvent.click(await screen.findByRole('button', { name: /change password/i }))
    expect(await screen.findByRole('dialog')).toHaveTextContent(/other browser or device/i)
  })
})

describe('recovery codes', () => {
  const NEWCODES = Array.from({ length: 10 }, (_, i) => `NNNN-EEEE-WWWW-CCC${i}`)
  const routes = (over = {}) => ({
    'GET /api/auth/logins': LOGINS,
    'GET /api/auth/recovery': { remaining: 10, createdAt: '2026-10-19T12:00:00Z' },
    ...over,
  })
  const ask = async () => {
    await userEvent.click(await screen.findByRole('button', { name: /make new codes/i }))
    return screen.findByRole('dialog')
  }

  test('says how many are left, never shows them, and where to go if they are lost too', async () => {
    mockApi(routes())
    page()
    expect(await screen.findByText(/10 of 10 recovery codes left/i)).toBeInTheDocument()
    expect(screen.getByText(/docker compose .* exec api node scripts\/reset-password\.js/i)).toBeInTheDocument()
  })

  test.each([[3, /only 3/i], [1, /only 1/i]])('%i left is a warning to make a new set', async (n, text) => {
    mockApi(routes({ 'GET /api/auth/recovery': { remaining: n, createdAt: '2026-10-19T12:00:00Z' } }))
    page()
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  test('none left is said plainly', async () => {
    mockApi(routes({ 'GET /api/auth/recovery': { remaining: 0, createdAt: '2026-10-19T12:00:00Z' } }))
    page()
    expect(await screen.findByText(/no recovery codes left/i)).toBeInTheDocument()
  })

  test('plenty left is not a warning', async () => {
    mockApi(routes({ 'GET /api/auth/recovery': { remaining: 4, createdAt: '2026-10-19T12:00:00Z' } }))
    page()
    await screen.findByText(/4 of 10 recovery codes left/i)
    expect(screen.queryByText(/only \d+ left/i)).toBeNull()
  })

  test('a new set needs the current password, replaces the old and is shown once', async () => {
    const api = mockApi(routes({ 'POST /api/auth/recovery': { codes: NEWCODES } }))
    page()
    const dialog = await ask()
    expect(dialog).toHaveTextContent(/old codes stop working/i)
    await userEvent.type(within(dialog).getByLabelText('Current password'), 'my-current-password')
    await userEvent.click(within(dialog).getByRole('button', { name: /make new codes/i }))
    for (const c of NEWCODES) expect(await within(dialog).findByText(c)).toBeInTheDocument()
    expect(api.called('POST', '/api/auth/recovery')[0].body).toEqual({ password: 'my-current-password' })
  })

  test('the codes cannot be dismissed by the escape key or the close button before they are saved', async () => {
    mockApi(routes({ 'POST /api/auth/recovery': { codes: NEWCODES } }))
    page()
    const dialog = await ask()
    await userEvent.type(within(dialog).getByLabelText('Current password'), 'my-current-password')
    await userEvent.click(within(dialog).getByRole('button', { name: /make new codes/i }))
    await within(dialog).findByText(NEWCODES[0])
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(dialog).getByText(NEWCODES[0])).toBeInTheDocument()
  })

  test('after "I have saved these" and Done the dialog closes and the count is read again', async () => {
    let status = { remaining: 4, createdAt: '2026-10-19T12:00:00Z' }
    mockApi(routes({ 'GET /api/auth/recovery': () => status, 'POST /api/auth/recovery': () => { status = { remaining: 10, createdAt: '2026-10-20T12:00:00Z' }; return { codes: NEWCODES } } }))
    page()
    await screen.findByText(/4 of 10/i)
    const dialog = await ask()
    await userEvent.type(within(dialog).getByLabelText('Current password'), 'my-current-password')
    await userEvent.click(within(dialog).getByRole('button', { name: /make new codes/i }))
    await within(dialog).findByText(NEWCODES[0])
    await userEvent.click(within(dialog).getByLabelText(/i have saved these/i))
    await userEvent.click(within(dialog).getByRole('button', { name: /done/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByText(/10 of 10/i)).toBeInTheDocument()
  })

  test('a wrong password is explained and the old codes stay', async () => {
    mockApi(routes({ 'POST /api/auth/recovery': answer(403, { error: 'The current password is not correct', code: 'wrong_password' }) }))
    page()
    const dialog = await ask()
    await userEvent.type(within(dialog).getByLabelText('Current password'), 'not-it-not-it-1')
    await userEvent.click(within(dialog).getByRole('button', { name: /make new codes/i }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The current password is not correct')
    expect(within(dialog).queryByText(NEWCODES[0])).toBeNull()
  })

  test('asking without a password sends nothing', async () => {
    const api = mockApi(routes())
    page()
    const dialog = await ask()
    await userEvent.click(within(dialog).getByRole('button', { name: /make new codes/i }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/current password/i)
    expect(api.called('POST', '/api/auth/recovery')).toHaveLength(0)
  })

  test('cancelling before anything is made just closes', async () => {
    mockApi(routes())
    page()
    const dialog = await ask()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
