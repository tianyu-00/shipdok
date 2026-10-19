import { describe, test, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AuthPage from './auth-page'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

describe('logging in', () => {
  test('sends the username and password, then re-checks the session', async () => {
    const api = mockApi({
      'POST /api/auth/login': { username: 'admin' },
      'GET /api/auth/status': { needsSetup: false, authenticated: true },
      'GET /api/auth/me': { username: 'admin' },
    })
    renderWithProviders(<AuthPage status={{ needsSetup: false, authenticated: false }} />)
    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), 'a-long-test-password')
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
    await waitFor(() => expect(api.called('POST', '/api/auth/login')).toHaveLength(1))
    expect(api.called('POST', '/api/auth/login')[0].body).toEqual({ username: 'admin', password: 'a-long-test-password' })
  })

  test('a wrong password shows the server\'s message and the form stays usable', async () => {
    mockApi({ 'POST /api/auth/login': () => { throw { status: 401, body: { error: 'Invalid username or password' } } } })
    renderWithProviders(<AuthPage status={{ needsSetup: false, authenticated: false }} />)
    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password-123')
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password')
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled()
  })

  test('says so when the session ended', () => {
    renderWithProviders(<AuthPage status={{ needsSetup: false, authenticated: false, expired: true }} />)
    expect(screen.getByText(/session ended/i)).toBeInTheDocument()
  })

  test('the login form has no setup fields', () => {
    renderWithProviders(<AuthPage status={{ needsSetup: false, authenticated: false }} />)
    expect(screen.queryByLabelText(/repeat the password/i)).toBeNull()
    expect(screen.queryByLabelText(/setup token/i)).toBeNull()
  })
})

describe('first-run setup', () => {
  const fill = async (password, confirm, token) => {
    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), password)
    await userEvent.type(screen.getByLabelText(/repeat the password/i), confirm)
    if (token) await userEvent.type(screen.getByLabelText(/setup token/i), token)
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
  }

  test('two different passwords are caught before anything is sent', async () => {
    const api = mockApi({})
    renderWithProviders(<AuthPage status={{ needsSetup: true, authenticated: false }} />)
    await fill('a-long-test-password', 'a-different-password')
    expect(await screen.findByRole('alert')).toHaveTextContent(/not the same/i)
    expect(api.calls).toHaveLength(0)
  })

  test('creates the account; the setup token is sent only when filled in', async () => {
    const api = mockApi({ 'POST /api/auth/setup': answer(201, { username: 'admin' }), 'GET /api/auth/status': { needsSetup: false, authenticated: true }, 'GET /api/auth/me': { username: 'admin' } })
    renderWithProviders(<AuthPage status={{ needsSetup: true, authenticated: false }} />)
    await fill('a-long-test-password', 'a-long-test-password')
    await waitFor(() => expect(api.called('POST', '/api/auth/setup')).toHaveLength(1))
    expect(api.called('POST', '/api/auth/setup')[0].body).toEqual({ username: 'admin', password: 'a-long-test-password' })
  })

  test('with a setup token it is included', async () => {
    const api = mockApi({ 'POST /api/auth/setup': answer(201, {}), 'GET /api/auth/status': { needsSetup: false, authenticated: true }, 'GET /api/auth/me': { username: 'admin' } })
    renderWithProviders(<AuthPage status={{ needsSetup: true, authenticated: false }} />)
    await fill('a-long-test-password', 'a-long-test-password', 'tok-123')
    await waitFor(() => expect(api.called('POST', '/api/auth/setup')).toHaveLength(1))
    expect(api.called('POST', '/api/auth/setup')[0].body.setupToken).toBe('tok-123')
  })

  test('the server\'s complaint (a short password) is shown', async () => {
    mockApi({ 'POST /api/auth/setup': () => { throw { status: 400, body: { error: 'Password must be 12-256 characters' } } } })
    renderWithProviders(<AuthPage status={{ needsSetup: true, authenticated: false }} />)
    await fill('short', 'short')
    expect(await screen.findByRole('alert')).toHaveTextContent('12-256 characters')
  })
})
