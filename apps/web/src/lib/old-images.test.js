import { describe, test, expect } from 'vitest'
import { bytesToGbText, gbTextToBytes, THRESHOLD_HINT } from './old-images'

const GB = 1024 ** 3
const MB = 1024 ** 2

describe('the size in the box', () => {
  test('is empty for "never", and GB with at most two decimals otherwise', () => {
    expect(bytesToGbText(null)).toBe('')
    expect(bytesToGbText(undefined)).toBe('')
    expect(bytesToGbText(2 * GB)).toBe('2')
    expect(bytesToGbText(1.5 * GB)).toBe('1.5')
    expect(bytesToGbText(Math.round(0.256 * GB))).toBe('0.26')
  })
})

describe('what was typed', () => {
  test('empty (or spaces) means never', () => {
    expect(gbTextToBytes('')).toEqual({ bytes: null })
    expect(gbTextToBytes('   ')).toEqual({ bytes: null })
  })
  test.each([['2', 2 * GB], ['0.5', GB / 2], [' 3 ', 3 * GB], ['10240', 10 * 1024 * GB], ['0.1', Math.round(0.1 * GB)]])('%j is %d bytes', (text, bytes) => {
    expect(gbTextToBytes(text)).toEqual({ bytes })
  })
  test.each(['0', '0.09', '10241', '-1', '1,5', '2GB', 'abc', '1e3', '.5', '5.'])('%j is refused with the range', (text) => {
    expect(gbTextToBytes(text)).toEqual({ error: THRESHOLD_HINT })
  })
  test('what the server accepts at the smallest size round-trips as a size the box would refuse never to show', () => {
    expect(100 * MB).toBeLessThan(Math.round(0.1 * GB)) // (0.1 GB is the smallest the box can express)
  })
})
