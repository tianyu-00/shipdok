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
  ],
}
const page = () => renderWithProviders(<SecurityPage />, { route: '/security' })

describe('the security page', () => {
  test('lists recent sign-ins with when, who, from where and how it went', async () => {
    mockApi({ 'GET /api/auth/logins': LOGINS })
    page()
    const rows = await screen.findAllByRole('row')
    const body = rows.slice(1) // header row first
    expect(body).toHaveLength(4)
    expect(within(body[0]).getByText('Signed in')).toBeInTheDocument()
    expect(within(body[0]).getByText('admin')).toBeInTheDocument()
    expect(within(body[0]).getByText('192.168.1.20')).toBeInTheDocument() // the ::ffff: prefix is noise
    expect(within(body[0]).getByText('1 min ago')).toBeInTheDocument()
    expect(within(body[1]).getByText('Failed')).toBeInTheDocument()
    expect(within(body[1]).getByText('root')).toBeInTheDocument()
    expect(within(body[1]).getByText('203.0.113.9')).toBeInTheDocument()
    expect(within(body[2]).getByText('Recovery code used')).toBeInTheDocument()
    expect(within(body[3]).getByText('Account created')).toBeInTheDocument()
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
    mockApi({ 'GET /api/auth/logins': () => { throw { status: 500, body: { error: 'boom' } } } })
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
