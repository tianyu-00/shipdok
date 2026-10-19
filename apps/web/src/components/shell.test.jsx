import { describe, test, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { Shell } from './shell'
import { mockApi, renderWithProviders } from '@/test/utils'

const access = (over) => ({ mode: 'local', publicUrl: '', modeLocked: false, urlLocked: false, visitor: 'local', ...over })

describe('the header', () => {
  test('links to the storage page and shows who is logged in', () => {
    mockApi({})
    renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    expect(screen.getByRole('link', { name: /storage/i })).toHaveAttribute('href', '/storage')
    expect(screen.getByRole('link', { name: /security/i })).toHaveAttribute('href', '/security')
    expect(screen.getByRole('link', { name: /shipdok/i })).toHaveAttribute('href', '/')
    expect(screen.getByText('admin')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull() // it lives on the Security page
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
