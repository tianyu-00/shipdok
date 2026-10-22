import { describe, test, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UpdateNotice } from './update-notice'
import { VersionIndicator } from './version-indicator'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const v = (over = {}) => ({ current: '0.1.14', latest: '0.1.15', updateAvailable: true, checkedAt: '2026-10-22T10:00:00Z', error: null, ...over })
const settle = () => new Promise((r) => setTimeout(r, 50))

describe('the update notice on the apps list', () => {
  test('says which version is available and which one runs', async () => {
    mockApi({ 'GET /api/version': v() })
    renderWithProviders(<UpdateNotice />)
    expect(await screen.findByText('Shipdok 0.1.15 is available')).toBeInTheDocument()
    expect(screen.getByText(/You are running 0\.1\.14/)).toBeInTheDocument()
  })

  test('Details says a new update is available and points at the release notes on GitHub, with no commands', async () => {
    mockApi({ 'GET /api/version': v() })
    renderWithProviders(<UpdateNotice />)
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }))
    expect(await screen.findByText(/A new update is available/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'GitHub releases' })).toHaveAttribute('href', 'https://github.com/tianyu-00/shipdok/releases')
    expect(screen.queryByText(/docker compose/)).toBeNull()
  })

  test.each([
    ['up to date', v({ latest: '0.1.14', updateAvailable: false })],
    ['the registry unreachable', v({ latest: null, updateAvailable: false, error: 'unreachable' })],
  ])('is not shown when %s', async (_, body) => {
    const api = mockApi({ 'GET /api/version': body })
    renderWithProviders(<UpdateNotice />)
    await settle()
    expect(api.called('GET', '/api/version').length).toBeGreaterThan(0)
    expect(screen.queryByText(/is available/)).toBeNull()
  })

  test('says nothing when the version cannot be loaded', async () => {
    const api = mockApi({ 'GET /api/version': answer(500, { error: 'boom' }) })
    renderWithProviders(<UpdateNotice />)
    await settle()
    expect(api.called('GET', '/api/version').length).toBeGreaterThan(0)
    expect(screen.queryByText(/is available/)).toBeNull()
  })

  test('Dismiss hides it, and it stays hidden when the page is opened again', async () => {
    mockApi({ 'GET /api/version': v() })
    const first = renderWithProviders(<UpdateNotice />)
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Shipdok 0.1.15 is available')).toBeNull()
    first.unmount()
    const api = mockApi({ 'GET /api/version': v() })
    renderWithProviders(<UpdateNotice />)
    await waitFor(() => expect(api.called('GET', '/api/version').length).toBeGreaterThan(0))
    await settle()
    expect(screen.queryByText('Shipdok 0.1.15 is available')).toBeNull()
  })

  test('a still newer release shows it again after a dismissal', async () => {
    mockApi({ 'GET /api/version': v() })
    const first = renderWithProviders(<UpdateNotice />)
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    first.unmount()
    mockApi({ 'GET /api/version': v({ latest: '0.1.16' }) })
    renderWithProviders(<UpdateNotice />)
    expect(await screen.findByText('Shipdok 0.1.16 is available')).toBeInTheDocument()
  })

  test('still works when the browser will not keep the dismissal', async () => {
    mockApi({ 'GET /api/version': v() })
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new Error('blocked') }
    try {
      renderWithProviders(<UpdateNotice />)
      await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
      expect(screen.queryByText('Shipdok 0.1.15 is available')).toBeNull()
    } finally {
      Storage.prototype.setItem = original
    }
  })
})

describe('the version beside the logo', () => {
  test('shows the version, and "Update available" when there is one', async () => {
    mockApi({ 'GET /api/version': v() })
    renderWithProviders(<VersionIndicator />)
    expect(await screen.findByText('v0.1.14')).toBeInTheDocument()
    expect(screen.getByText('Update available')).toBeInTheDocument()
  })

  test('only the version when up to date', async () => {
    mockApi({ 'GET /api/version': v({ latest: '0.1.14', updateAvailable: false }) })
    renderWithProviders(<VersionIndicator />)
    expect(await screen.findByText('v0.1.14')).toBeInTheDocument()
    expect(screen.queryByText('Update available')).toBeNull()
  })

  test('nothing when the version is unknown and there is no update, or when it cannot be loaded', async () => {
    mockApi({ 'GET /api/version': v({ current: null, updateAvailable: false }) })
    const a = renderWithProviders(<VersionIndicator />)
    await settle()
    expect(a.container.querySelector('button')).toBeNull()
    a.unmount()
    mockApi({ 'GET /api/version': answer(500, {}) })
    const b = renderWithProviders(<VersionIndicator />)
    await settle()
    expect(b.container.querySelector('button')).toBeNull()
  })

  test('it is not hidden by dismissing the notice', async () => {
    localStorage.setItem('shipdok-dismissed-update', '0.1.15')
    mockApi({ 'GET /api/version': v() })
    renderWithProviders(<VersionIndicator />)
    expect(await screen.findByText('Update available')).toBeInTheDocument()
  })

  test('pressing it explains, and Check now asks for a fresh look and shows the new answer', async () => {
    let fresh = 0
    mockApi({ 'GET /api/version': v(), 'GET /api/version?fresh=1': () => { fresh += 1; return v({ latest: '0.1.20' }) } })
    renderWithProviders(<VersionIndicator />)
    await userEvent.click(await screen.findByRole('button', { name: /update 0\.1\.15 available/ }))
    expect(await screen.findByText('0.1.15', { selector: 'strong' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(fresh).toBe(1))
    expect(await screen.findByText('0.1.20', { selector: 'strong' })).toBeInTheDocument()
  })

  test('says plainly when the registry could not be reached', async () => {
    mockApi({ 'GET /api/version': v({ latest: null, updateAvailable: false, error: 'unreachable' }) })
    renderWithProviders(<VersionIndicator />)
    await userEvent.click(await screen.findByRole('button', { name: 'Version 0.1.14' }))
    expect(await screen.findByText(/Could not look for updates just now/)).toBeInTheDocument()
  })
})
