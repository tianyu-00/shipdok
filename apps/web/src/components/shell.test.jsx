import { describe, test, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { Shell } from './shell'
import { mockApi, renderWithProviders } from '@/test/utils'

const access = (over) => ({ mode: 'local', publicUrl: '', modeLocked: false, urlLocked: false, visitor: 'local', ...over })

describe('the recovery codes notice', () => {
  const left = (remaining) => ({ 'GET /api/auth/recovery': { remaining, createdAt: '2026-10-01T10:00:00Z' } })
  const notice = () => screen.findByRole('status', { name: /recovery codes/i })

  test.each([10, 4])('with %i left there is no notice', async (n) => {
    mockApi(left(n))
    renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    await screen.findByText('page')
    await new Promise((r) => setTimeout(r, 30)) // the count has been fetched by now
    expect(screen.queryByRole('status', { name: /recovery codes/i })).toBeNull()
  })

  test('at 3 or fewer it says how many are left and links to where new ones are made', async () => {
    mockApi(left(3))
    renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    const banner = await notice()
    expect(banner).toHaveTextContent(/3 recovery codes left/i)
    expect(within(banner).getByRole('link', { name: /make new codes/i })).toHaveAttribute('href', '/security')
  })

  test('one left is worded for one; none left says so plainly', async () => {
    mockApi(left(1))
    const { unmount } = renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    expect(await notice()).toHaveTextContent(/1 recovery code left/i)
    unmount()
    mockApi(left(0))
    renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    expect(await notice()).toHaveTextContent(/no recovery codes left/i)
  })

  test('if the count cannot be read there is no notice (and no error)', async () => {
    mockApi({})
    renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    expect(await screen.findByText('page')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: /recovery codes/i })).toBeNull()
  })
})

describe('the header', () => {
  test('links to the storage page and shows who is logged in', () => {
    mockApi({})
    renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    expect(screen.getByRole('link', { name: /storage/i })).toHaveAttribute('href', '/storage')
    expect(screen.getByRole('link', { name: /security/i })).toHaveAttribute('href', '/security')
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', '/github')
    expect(screen.getByRole('link', { name: /shipdok/i })).toHaveAttribute('href', '/')
    expect(screen.getByText('admin')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull() // it lives on the Security page
  })

  test('has an API link that opens the API reference in a new tab', () => {
    mockApi({})
    renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    const link = screen.getByRole('link', { name: 'API' })
    expect(link).toHaveAttribute('href', '/api/docs')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toMatch(/noopener/)
  })

  test('no banner while nothing is reachable from outside', async () => {
    mockApi({ 'GET /api/settings/public': access({ mode: 'local' }) })
    renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    await screen.findByText('page')
    expect(screen.queryByRole('status', { name: /public/i })).toBeNull()
  })

  test('no banner for webhook only', async () => {
    mockApi({ 'GET /api/settings/public': access({ mode: 'webhook' }) })
    renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    await screen.findByText('page')
    expect(screen.queryByText(/reachable from the internet/i)).toBeNull()
  })

  test('a banner while the whole dashboard is reachable from the internet, with a link to change it', async () => {
    mockApi({ 'GET /api/settings/public': access({ mode: 'full' }) })
    renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    const banner = await screen.findByRole('status', { name: /public access/i })
    expect(banner).toHaveTextContent(/reachable from the internet/i)
    expect(within(banner).getByRole('link', { name: /security/i })).toHaveAttribute('href', '/security')
  })

  test('the header still works when the setting cannot be read', async () => {
    mockApi({})
    renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    expect(await screen.findByText('page')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: /public access/i })).toBeNull()
  })
})
