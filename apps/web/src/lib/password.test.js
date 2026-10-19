import { describe, test, expect } from 'vitest'
import { strength } from './password'

describe('strength', () => {
  test('nothing typed shows nothing', () => expect(strength('')).toBeNull())

  test.each([
    ['x'.repeat(11), 0, 'Too short'],
    ['x'.repeat(12), 1, 'Acceptable'],
    ['x'.repeat(15), 1, 'Acceptable'],
    ['x'.repeat(16), 2, 'Good'],
    ['x'.repeat(23), 2, 'Good'],
    ['x'.repeat(24), 3, 'Strong'],
    ['x'.repeat(100), 3, 'Strong'],
  ])('%s characters -> level %i %s', (pw, level, label) => {
    expect(strength(pw)).toEqual({ level, label })
  })
})
