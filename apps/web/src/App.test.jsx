import { describe, test, expect, vi, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { makeApp } from '@/test/fixtures'

const signedIn = { 'GET /api/auth/status': { needsSetup: false, authenticated: true }, 'GET /api/auth/me': { username: 'admin' } }

describe('who sees what', () => {
  test('a visitor who is not logged in sees only the login page', async () => {
    const api = mockApi({ 'GET /api/auth/status': { needsSetup: false, authenticated: false } })
    renderWithProviders(<App />)
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument()
    expect(api.called('GET', '/api/apps')).toHaveLength(0)
  })

  test('a fresh installation offers account creation', async () => {
    mockApi({ 'GET /api/auth/status': { needsSetup: true, authenticated: false } })
    renderWithProviders(<App />)
    expect(await screen.findByRole('button', { name: 'Create account' })).toBeInTheDocument()
  })

  test('a logged-in administrator sees the apps and their own name', async () => {
    mockApi({ ...signedIn, 'GET /api/apps': [makeApp()], 'GET /api/storage': { disk: { level: 'ok' } } })
    renderWithProviders(<App />)
    expect(await screen.findByRole('link', { name: 'My App' })).toBeInTheDocument()
    expect(screen.getByText('admin')).toBeInTheDocument()
  })

  test('an API that cannot be reached says so, with a way to try again', async () => {
    const { vi } = await import('vitest')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    renderWithProviders(<App />)
    expect(await screen.findByText('Cannot reach Shipdok')).toBeInTheDocument()
    expect(screen.getByText(/Cannot reach the Shipdok API/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  test('unknown addresses go to the apps list', async () => {
    mockApi({ ...signedIn, 'GET /api/apps': [], 'GET /api/storage': {} })
    renderWithProviders(<App />, { route: '/nowhere/at/all' })
    expect(await screen.findByRole('heading', { name: 'Apps' })).toBeInTheDocument()
  })
})

describe('coming back from the API reference', () => {
  const realLocation = window.location
  afterEach(() => { Object.defineProperty(window, 'location', { value: realLocation, writable: true, configurable: true }) })
  const spyOnReplace = () => {
    const replace = vi.fn()
    Object.defineProperty(window, 'location', { value: { ...realLocation, replace }, writable: true, configurable: true })
    return replace
  }

  test('signed out, /api-docs shows the login form, and nothing is opened', async () => {
    const replace = spyOnReplace()
    mockApi({ 'GET /api/auth/status': { needsSetup: false, authenticated: false } })
    renderWithProviders(<App />, { route: '/api-docs' })
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  test('once signed in, /api-docs goes on to the API reference', async () => {
    const replace = spyOnReplace()
    mockApi({ ...signedIn, 'GET /api/apps': [], 'GET /api/storage': {} })
    renderWithProviders(<App />, { route: '/api-docs' })
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/api/docs'))
    expect(screen.getByRole('link', { name: /api reference/i })).toHaveAttribute('href', '/api/docs') // in case the browser does not follow
  })
})

describe('the session ends while using the dashboard', () => {
  test('a refused request sends you back to the login page with an explanation, and the data is gone', async () => {
    let calls = 0
    mockApi({
      ...signedIn,
      'GET /api/storage': {},
      'GET /api/apps': () => { calls += 1; if (calls > 1) throw { status: 401, body: { error: 'Not authenticated' } }; return [makeApp()] },
    })
    const { client } = renderWithProviders(<App />)
    await screen.findByRole('link', { name: 'My App' })
    await client.invalidateQueries({ queryKey: ['apps'] })
    expect(await screen.findByText(/session ended/i)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'My App' })).toBeNull()
    expect(client.getQueryData(['apps'])).toBeUndefined() // nothing of the old session is kept for whoever logs in next
  })
})

describe('logging out', () => {
  test('calls the API and shows the login page, even if the call fails', async () => {
    mockApi({ ...signedIn, 'GET /api/apps': [], 'GET /api/storage': {}, 'POST /api/auth/logout': answer(500, { error: 'boom' }) })
    const { client } = renderWithProviders(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Log out' }))
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument()
    expect(client.getQueryData(['apps'])).toBeUndefined()
  })
})
