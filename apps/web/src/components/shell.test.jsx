import { describe, test, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { Shell } from './shell'
import { mockApi, renderWithProviders } from '@/test/utils'

describe('the header', () => {
  test('links to the storage page and shows who is logged in', () => {
    mockApi({})
    renderWithProviders(<Shell username="admin"><p>page</p></Shell>)
    expect(screen.getByRole('link', { name: /storage/i })).toHaveAttribute('href', '/storage')
    expect(screen.getByRole('link', { name: /shipdok/i })).toHaveAttribute('href', '/')
    expect(screen.getByText('admin')).toBeInTheDocument()
  })
})
