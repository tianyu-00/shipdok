import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PasswordHelp } from './password-help'

describe('PasswordHelp', () => {
  test('before anything is typed it explains why length matters, without a meter', () => {
    render(<PasswordHelp value="" />)
    expect(screen.getByText(/long, unique password/i)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /strength/i })).toBeNull()
  })

  test.each([
    ['short', 'Too short', 0],
    ['x'.repeat(12), 'Acceptable', 1],
    ['x'.repeat(16), 'Good', 2],
    ['x'.repeat(30), 'Strong', 3],
  ])('%s shows %s', (value, label, level) => {
    render(<PasswordHelp value={value} />)
    const meter = screen.getByRole('img', { name: `Strength: ${label}` })
    expect(meter.querySelectorAll('[data-filled="true"]')).toHaveLength(level + 1)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})
