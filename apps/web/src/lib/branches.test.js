import { describe, test, expect } from 'vitest'
import { isRepoName, branchOptions, stepActive, startActive, OPTION_LIMIT } from './branches'

describe('isRepoName', () => {
  test.each(['o/r', 'tianyu-00/shipdok-test-app', 'a.b/c_d', 'O/R'])('%s is a repository', (r) => expect(isRepoName(r)).toBe(true))
  test.each(['', 'x', 'a/b/c', '../x', 'o/..', 'o /r', 'o/r?x=1', 'o/r#', undefined, null, 5])('%j is not', (r) => expect(isRepoName(r)).toBe(false))
})

describe('branchOptions', () => {
  const branches = ['main', 'develop', 'feature/login', 'feature/Logout', 'release']

  test('no text: every branch, the default marked, in the order given, and no "use this name" option', () => {
    const { options, more } = branchOptions(branches, '', 'main')
    expect(options.map((o) => o.name)).toEqual(branches)
    expect(options.filter((o) => o.isDefault).map((o) => o.name)).toEqual(['main'])
    expect(options.some((o) => o.custom)).toBe(false)
    expect(more).toBe(0)
  })

  test('the text narrows the list, ignoring case', () => {
    expect(branchOptions(branches, 'LOG', 'main').options.filter((o) => !o.custom).map((o) => o.name)).toEqual(['feature/login', 'feature/Logout'])
  })

  test('text that is not exactly a branch adds a "use this name" option, last', () => {
    const { options } = branchOptions(branches, 'feature', 'main')
    expect(options.map((o) => [o.name, o.custom])).toEqual([['feature/login', false], ['feature/Logout', false], ['feature', true]])
  })

  test('text that is exactly a branch does not', () => {
    expect(branchOptions(branches, 'release', 'main').options.map((o) => o.custom)).toEqual([false])
  })

  test('a different case is a different name: "Main" can be used as typed', () => {
    const { options } = branchOptions(branches, 'Main', 'main')
    expect(options.map((o) => [o.name, o.custom])).toEqual([['main', false], ['Main', true]])
  })

  test('nothing matches: only the "use this name" option', () => {
    expect(branchOptions(branches, 'zzz', 'main').options).toEqual([{ name: 'zzz', isDefault: false, custom: true }])
  })

  test('spaces around the text are ignored', () => {
    expect(branchOptions(branches, '  release  ', 'main').options.map((o) => o.name)).toEqual(['release'])
  })

  test('only the first matches are drawn, and it says how many were left out', () => {
    const many = Array.from({ length: OPTION_LIMIT + 25 }, (_, i) => `b${i}`)
    const { options, more } = branchOptions(many, '', null)
    expect(options).toHaveLength(OPTION_LIMIT)
    expect(more).toBe(25)
  })

  test('an empty or missing list is fine', () => {
    expect(branchOptions([], '', null)).toEqual({ options: [], more: 0 })
    expect(branchOptions(undefined, 'x', null).options.map((o) => o.name)).toEqual(['x'])
  })
})

describe('stepActive', () => {
  test('moves and wraps round at both ends', () => {
    expect([stepActive(0, 1, 3), stepActive(2, 1, 3), stepActive(0, -1, 3), stepActive(1, -1, 3)]).toEqual([1, 0, 2, 0])
  })
  test('from nothing highlighted: down goes to the first, up to the last', () => {
    expect([stepActive(-1, 1, 3), stepActive(-1, -1, 3)]).toEqual([0, 2])
  })
  test('nothing to highlight', () => expect(stepActive(0, 1, 0)).toBe(-1))
})

describe('startActive', () => {
  const options = [{ name: 'main' }, { name: 'dev' }, { name: 'x', custom: true }]
  test('starts on the current branch when it is listed', () => expect(startActive(options, 'dev')).toBe(1))
  test('otherwise on the first option', () => expect(startActive(options, 'gone')).toBe(0))
  test('a "use this name" option is never the current branch', () => expect(startActive(options, 'x')).toBe(0))
  test('no options', () => expect(startActive([], 'main')).toBe(-1))
})
