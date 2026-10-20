import { describe, test, expect } from 'vitest'
import { parseRepoInput } from './repo'

describe('parseRepoInput: links that point at a GitHub repository', () => {
  test.each([
    ['https://github.com/tianyu-00/shipdok-test-app', 'tianyu-00/shipdok-test-app'],
    ['http://github.com/o/r', 'o/r'],
    ['https://www.github.com/o/r', 'o/r'],
    ['github.com/o/r', 'o/r'],
    ['www.github.com/o/r', 'o/r'],
    ['https://github.com/o/r/', 'o/r'],
    ['https://github.com/o/r.git', 'o/r'],
    ['https://github.com/o/r.GIT', 'o/r'],
    ['https://github.com/o/r/tree/develop', 'o/r'],
    ['https://github.com/o/r/tree/feature/login/src', 'o/r'],
    ['https://github.com/o/r/blob/main/README.md', 'o/r'],
    ['https://github.com/o/r?tab=readme', 'o/r'],
    ['https://github.com/o/r#readme', 'o/r'],
    ['https://github.com/o/r?', 'o/r'],
    ['https://github.com/o/r/pull/12', 'o/r'],
    ['git@github.com:o/r.git', 'o/r'],
    ['git@github.com:o/r', 'o/r'],
    ['ssh://git@github.com/o/r.git', 'o/r'],
    ['git://github.com/o/r.git', 'o/r'],
    ['https://someone@github.com/o/r.git', 'o/r'],
    ['HTTPS://GitHub.com/O/R', 'O/R'],
    ['  https://github.com/o/r  ', 'o/r'],
    ['https://github.com/a.b/c_d-e.f', 'a.b/c_d-e.f'],
  ])('%s -> %s', (input, expected) => expect(parseRepoInput(input)).toBe(expected))
})

describe('parseRepoInput: everything else is left alone (null)', () => {
  test.each([
    'o/r', 'owner/name', '', '   ', 'x', undefined, null, 5,
    'https://gitlab.com/o/r', 'https://bitbucket.org/o/r', 'https://example.com/github.com/o/r',
    'https://github.com.evil.example/o/r', 'https://evil.example/?u=github.com/o/r', 'https://github.comx/o/r',
    'https://github.com', 'https://github.com/', 'https://github.com/o', 'https://github.com/o/', 'https://github.com//r',
    'https://github.com/o/..', 'https://github.com/../r', 'https://github.com/o/r r', 'https://github.com/o/%72',
    'git@gitlab.com:o/r.git', 'git@github.com:', 'git@github.com:o',
    'javascript:alert(1)//github.com/o/r',
  ])('%j', (input) => expect(parseRepoInput(input)).toBeNull())

  test('a repository that is only called ".git" is not a repository', () => {
    expect(parseRepoInput('https://github.com/o/.git')).toBeNull()
  })

  test('it never returns anything that is not owner/name in the API\'s shape', () => {
    for (const input of ['https://github.com/o/r', 'git@github.com:o/r.git', 'github.com/a.b/c-d']) expect(parseRepoInput(input)).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  })
})
