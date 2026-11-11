import { describe, test, expect, vi } from 'vitest'
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, pageOf, savePageSize, savedPageSize } from './paging'

describe('paging', () => {
  test('the choices and the default', () => {
    expect(PAGE_SIZES).toEqual([5, 10, 25, 50])
    expect(DEFAULT_PAGE_SIZE).toBe(10)
  })

  test('pageOf cuts a list into pages, never past either end, and says which page it really is', () => {
    const list = Array.from({ length: 12 }, (_, i) => i)
    expect(pageOf(list, 0, 5)).toEqual({ items: [0, 1, 2, 3, 4], page: 0, pages: 3 })
    expect(pageOf(list, 2, 5)).toEqual({ items: [10, 11], page: 2, pages: 3 })
    expect(pageOf(list, 9, 5).page).toBe(2)
    expect(pageOf(list, -4, 5).page).toBe(0)
    expect(pageOf([], 3, 5)).toEqual({ items: [], page: 0, pages: 1 })
    expect(pageOf(list, 0, 12).pages).toBe(1)
    expect(pageOf(list, 0, 11).pages).toBe(2)
  })

  test('a list starts at the default (10) or at the size it asks for, until this browser saved one of the choices under its own key', () => {
    localStorage.clear()
    expect(savedPageSize('a')).toBe(10)
    expect(savedPageSize('a', 5)).toBe(5)
    savePageSize('a', 25)
    expect(savedPageSize('a')).toBe(25)
    expect(savedPageSize('a', 5)).toBe(25)
    expect(savedPageSize('b', 5)).toBe(5) // another list is not affected
  })

  test('a stored value that is not one of the choices is ignored', () => {
    localStorage.setItem('c', '7')
    expect(savedPageSize('c')).toBe(10)
    expect(savedPageSize('c', 5)).toBe(5)
    localStorage.setItem('c', 'many')
    expect(savedPageSize('c', 5)).toBe(5)
  })

  test('storage that fails is only a convenience', () => {
    const noRead = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(savedPageSize('d')).toBe(10)
    expect(savedPageSize('d', 5)).toBe(5)
    noRead.mockRestore()
    const noSave = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => savePageSize('d', 10)).not.toThrow()
    noSave.mockRestore()
  })
})
