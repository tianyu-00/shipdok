import { describe, test, expect } from 'vitest'
import { METHOD_CARDS, DEFAULT_METHOD, cardFor } from './build-methods'

describe('the cards', () => {
  test('Dockerfile and Railpack can be chosen; Nixpacks and Static are coming soon', () => {
    expect(METHOD_CARDS.map((c) => [c.id, c.available])).toEqual([['dockerfile', true], ['railpack', true], ['nixpacks', false], ['static', false]])
  })
  test('Railpack is the default, and it can be chosen (a default that cannot be chosen would trap the form)', () => {
    expect(DEFAULT_METHOD).toBe('railpack')
    expect(cardFor(DEFAULT_METHOD).available).toBe(true)
  })
  test('every card says what it is', () => {
    for (const c of METHOD_CARDS) expect(c.text.length).toBeGreaterThan(20)
  })
  test('looking one up', () => {
    expect(cardFor('railpack').title).toBe('Railpack')
    expect(cardFor('nope')).toBeNull()
  })
})
