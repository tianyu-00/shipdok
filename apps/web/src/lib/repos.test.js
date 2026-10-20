import { describe, test, expect } from 'vitest'
import { repoOptions } from './repos'
import { OPTION_LIMIT } from './branches'

const repos = [
  { fullName: 'tianyu-00/site', private: true },
  { fullName: 'tianyu-00/api', private: false },
  { fullName: 'Acme/Widgets', private: true },
  { fullName: 'acme/gadgets', private: false },
]
const names = (o) => o.options.map((x) => x.name)

describe('repoOptions', () => {
  test('no text: every repository, alphabetical (ignoring case), each marked private or public, and no "use this" option', () => {
    const out = repoOptions(repos, '')
    expect(names(out)).toEqual(['acme/gadgets', 'Acme/Widgets', 'tianyu-00/api', 'tianyu-00/site'])
    expect(out.options.map((o) => o.private)).toEqual([false, true, false, true])
    expect(out.options.some((o) => o.custom)).toBe(false)
    expect(out.more).toBe(0)
  })

  test('upper and lower case sort together: by the letters, not capitals first or last', () => {
    expect(names(repoOptions([{ fullName: 'b/x' }, { fullName: 'B/a' }, { fullName: 'a/Z' }], ''))).toEqual(['a/Z', 'B/a', 'b/x'])
  })

  test('the text narrows the list, ignoring case, anywhere in the name', () => {
    expect(names(repoOptions(repos, 'ACME')).filter((n) => !n.startsWith('ACME'))).toEqual(['acme/gadgets', 'Acme/Widgets'])
    expect(names(repoOptions(repos, 'widg'))[0]).toBe('Acme/Widgets')
  })

  test('a pasted GitHub link finds the repository it points at', () => {
    expect(names(repoOptions(repos, 'https://github.com/tianyu-00/site.git'))).toEqual(['tianyu-00/site'])
    expect(names(repoOptions(repos, 'git@github.com:acme/gadgets.git'))).toEqual(['acme/gadgets'])
  })

  test('an owner/name nobody listed is offered last, to use as typed', () => {
    const out = repoOptions(repos, 'someone/else')
    expect(out.options).toEqual([{ name: 'someone/else', private: false, custom: true }])
  })

  test('a link to a repository nobody listed is offered as owner/name, not as the link', () => {
    expect(repoOptions(repos, 'https://github.com/someone/else/tree/main').options).toEqual([{ name: 'someone/else', private: false, custom: true }])
  })

  test('half a name that is still a usable owner/name is offered after the matches', () => {
    const out = repoOptions(repos, 'tianyu-00/s')
    expect(out.options.map((o) => [o.name, o.custom])).toEqual([['tianyu-00/site', false], ['tianyu-00/s', true]])
  })

  test('a repository that is listed is not offered again, whatever its case (GitHub ignores case)', () => {
    expect(repoOptions(repos, 'TIANYU-00/SITE').options.map((o) => o.custom)).toEqual([false])
    expect(repoOptions(repos, 'tianyu-00/site').options.map((o) => o.custom)).toEqual([false])
  })

  test('text that cannot be a repository offers nothing to use', () => {
    for (const text of ['zzz', 'a/b/c', '../x', 'o/..', 'https://gitlab.com/o/r', 'has space/x']) {
      expect(repoOptions(repos, text).options.some((o) => o.custom), text).toBe(false)
    }
  })

  test('spaces around the text are ignored', () => {
    expect(names(repoOptions(repos, '  tianyu-00/site  '))).toEqual(['tianyu-00/site'])
  })

  test('only the first matches are drawn and it says how many were left out', () => {
    const many = Array.from({ length: OPTION_LIMIT + 7 }, (_, i) => ({ fullName: `o/r${String(i).padStart(3, '0')}`, private: false }))
    const out = repoOptions(many, '')
    expect(out.options).toHaveLength(OPTION_LIMIT)
    expect(out.more).toBe(7)
  })

  test('no list at all is fine', () => {
    expect(repoOptions(undefined, '')).toEqual({ options: [], more: 0 })
    expect(repoOptions([], 'o/r').options).toEqual([{ name: 'o/r', private: false, custom: true }])
  })

  test('the list it is given is not reordered', () => {
    const given = [...repos]
    repoOptions(given, '')
    expect(given).toEqual(repos)
  })
})
