import { describe, test, expect } from 'vitest'
import { publicUrlProblem, webhookUrl } from './publicaccess'

describe('publicUrlProblem', () => {
  test.each(['', 'https://shipdok.example.com', 'https://shipdok.example.com/', 'http://192.168.1.5:8080', '  https://shipdok.example.com  '])('%s is fine', (v) => expect(publicUrlProblem(v)).toBeNull())

  test.each([
    ['shipdok.example.com', /start with https/i],
    ['ftp://shipdok.example.com', /start with https/i],
    ['https://', /address/i],
    ['https://shipdok.example.com/path', /path/i],
    ['https://shipdok.example.com/?a=1', /path/i],
    ['https://user:pw@shipdok.example.com', /user name/i],
    ['https://exa mple.com', /address/i],
  ])('%s is refused', (v, why) => expect(publicUrlProblem(v)).toMatch(why))
})

describe('webhookUrl', () => {
  test('is the address plus the webhook path, without a doubled slash', () => {
    expect(webhookUrl('https://shipdok.example.com')).toBe('https://shipdok.example.com/api/webhooks/github')
    expect(webhookUrl('https://shipdok.example.com/')).toBe('https://shipdok.example.com/api/webhooks/github')
  })
  test('is null without an address', () => {
    expect(webhookUrl('')).toBeNull()
    expect(webhookUrl(undefined)).toBeNull()
  })
})
