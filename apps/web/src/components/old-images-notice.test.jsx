import { describe, test, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { OldImagesNotice } from './old-images-notice'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const MB = 1024 ** 2
const o = (over = {}) => ({ reclaimableBytes: 3000 * MB, apps: [], autoCleanup: { on: 0, total: 0 }, thresholdBytes: 2048 * MB, exceeded: true, ...over })

describe('the notice about old images', () => {
  test('is shown when the size the user set has been reached, with the amount and a way to the clean-up', async () => {
    mockApi({ 'GET /api/images': o() })
    renderWithProviders(<OldImagesNotice />)
    expect(await screen.findByText('Old images are piling up')).toBeInTheDocument()
    expect(screen.getByText(/could free about 2\.9 GB/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Clean up on the Storage page' })).toHaveAttribute('href', '/storage')
  })

  test('is not shown when the size has not been reached (or none was set, the default)', async () => {
    const api = mockApi({ 'GET /api/images': o({ exceeded: false }) })
    renderWithProviders(<OldImagesNotice />)
    await new Promise((r) => setTimeout(r, 50))
    expect(api.called('GET', '/api/images').length).toBeGreaterThan(0)
    expect(screen.queryByText('Old images are piling up')).toBeNull()
  })

  test('says nothing when the figures cannot be loaded', async () => {
    const api = mockApi({ 'GET /api/images': answer(500, { error: 'boom' }) })
    renderWithProviders(<OldImagesNotice />)
    await new Promise((r) => setTimeout(r, 50))
    expect(api.called('GET', '/api/images').length).toBeGreaterThan(0)
    expect(screen.queryByText('Old images are piling up')).toBeNull()
  })
})
