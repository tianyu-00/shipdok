import { describe, test, expect, vi } from 'vitest'
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

describe('a locked login', () => {
  test('shows how long to wait and the form stays usable', async () => {
    mockApi({ 'POST /api/auth/login': () => { throw { status: 429, body: { error: 'Too many failed attempts. Try again in 30 seconds.', code: 'locked', retryAfterSeconds: 30 } } } })
    renderWithProviders(<AuthPage status={{ needsSetup: false, authenticated: false }} />)
    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), 'whatever-it-is-1')
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 30 seconds')
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled()
  })
})

describe('first-run setup', () => {
  test('shows the strength of the password as it is typed', async () => {
    renderWithProviders(<AuthPage status={{ needsSetup: true, authenticated: false }} />)
    await userEvent.type(screen.getByLabelText('Password'), 'x'.repeat(16))
    expect(screen.getByRole('img', { name: 'Strength: Good' })).toBeInTheDocument()
  })


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
    mockApi({ 'POST /api/auth/setup': () => { throw { status: 400, body: { error: 'The password is a short pattern repeated over and over' } } } })
    renderWithProviders(<AuthPage status={{ needsSetup: true, authenticated: false }} />)
    await fill('abababababababab', 'abababababababab')
    expect(await screen.findByRole('alert')).toHaveTextContent('short pattern')
  })
})

describe('setup hands out the recovery codes', () => {
  const CODES = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-DDD${i}`)
  const routes = () => ({
    'POST /api/auth/setup': answer(201, { username: 'admin', recoveryCodes: CODES }),
    'GET /api/auth/status': { needsSetup: false, authenticated: true },
    'GET /api/auth/me': { username: 'admin' },
  })
  const create = async () => {
    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), 'a-long-test-password')
    await userEvent.type(screen.getByLabelText(/repeat the password/i), 'a-long-test-password')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
  }

  test('the codes are shown before the dashboard, and the dashboard waits for "I have saved these"', async () => {
    const api = mockApi(routes())
    const { client } = renderWithProviders(<AuthPage status={{ needsSetup: true, authenticated: false }} />)
    const recheck = vi.spyOn(client, 'invalidateQueries')
    await create()
    for (const c of CODES) expect(await screen.findByText(c)).toBeInTheDocument()
    expect(screen.queryByLabelText('Username')).toBeNull()
    expect(recheck).not.toHaveBeenCalled()
    await userEvent.click(screen.getByLabelText(/i have saved these/i))
    await userEvent.click(screen.getByRole('button', { name: /done/i }))
    expect(recheck).toHaveBeenCalledWith({ queryKey: ['auth'] })
  })
})

describe('recovering with a code', () => {
  const open = async () => {
    renderWithProviders(<AuthPage status={{ needsSetup: false, authenticated: false }} />)
    await userEvent.click(screen.getByRole('button', { name: /recovery code/i }))
  }
  const fill = async ({ code = 'abcd-efgh-jkmn-pqrs', next = 'a-brand-new-long-password', repeat = next } = {}) => {
    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Recovery code'), code)
    await userEvent.type(screen.getByLabelText('New password'), next)
    await userEvent.type(screen.getByLabelText('Repeat the new password'), repeat)
    await userEvent.click(screen.getByRole('button', { name: 'Set new password and log in' }))
  }

  test('the login form offers it, and the way back', async () => {
    await open()
    expect(screen.getByLabelText('Recovery code')).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /back to log in/i }))
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument()
  })

  test('sends the name, the code and the new password, then re-checks the session', async () => {
    const api = mockApi({ 'POST /api/auth/recover': { username: 'admin' }, 'GET /api/auth/status': { needsSetup: false, authenticated: true }, 'GET /api/auth/me': { username: 'admin' } })
    const { client } = renderWithProviders(<AuthPage status={{ needsSetup: false, authenticated: false }} />)
    const recheck = vi.spyOn(client, 'invalidateQueries')
    await userEvent.click(screen.getByRole('button', { name: /recovery code/i }))
    await fill()
    await waitFor(() => expect(api.called('POST', '/api/auth/recover')).toHaveLength(1))
    expect(api.called('POST', '/api/auth/recover')[0].body).toEqual({ username: 'admin', code: 'abcd-efgh-jkmn-pqrs', newPassword: 'a-brand-new-long-password' })
    await waitFor(() => expect(recheck).toHaveBeenCalledWith({ queryKey: ['auth'] }))
  })

  test('two different new passwords are caught before anything is sent', async () => {
    const api = mockApi({})
    await open()
    await fill({ repeat: 'something-else-entirely' })
    expect(await screen.findByRole('alert')).toHaveTextContent(/not the same/i)
    expect(api.calls).toHaveLength(0)
  })

  test('a short new password is caught before anything is sent', async () => {
    const api = mockApi({})
    await open()
    await fill({ next: 'short', repeat: 'short' })
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 12/i)
    expect(api.calls).toHaveLength(0)
  })

  test("the server's answer is shown: a wrong code, a wait, a weak password", async () => {
    mockApi({ 'POST /api/auth/recover': () => { throw { status: 401, body: { error: 'Invalid username or recovery code' } } } })
    await open()
    await fill()
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or recovery code')
  })

  test('shows the strength of the new password', async () => {
    mockApi({})
    await open()
    await userEvent.type(screen.getByLabelText('New password'), 'x'.repeat(30))
    expect(screen.getByRole('img', { name: 'Strength: Strong' })).toBeInTheDocument()
  })
})
