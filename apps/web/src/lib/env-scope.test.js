import { describe, test, expect } from 'vitest'
import { SCOPES, BUILD_PASSES, scopeLabel, scopeBadgeClass, reachesBuild, secretMount, buildNameProblem, nameFormatProblem } from './env-scope'

describe('scopes', () => {
  test('runtime, build, both, in that order, with readable labels', () => {
    expect(SCOPES.map((s) => s.value)).toEqual(['runtime', 'build', 'both'])
    expect(SCOPES.map((s) => s.label)).toEqual(['Runtime', 'Build only', 'Build and runtime'])
  })
  test('a missing or unknown scope is shown as runtime', () => {
    expect([scopeLabel(undefined), scopeLabel('nonsense'), scopeLabel('build'), scopeLabel('both')]).toEqual(['Runtime', 'Runtime', 'Build', 'Build + runtime'])
  })
  test('only build and both reach the build', () => {
    expect(['runtime', 'build', 'both', undefined].map(reachesBuild)).toEqual([false, true, true, false])
  })
})

describe('build secrets', () => {
  test('argument first (the default), then secret', () => {
    expect(BUILD_PASSES.map((p) => p.value)).toEqual(['arg', 'secret'])
  })
  test('the badge says secret only for a variable that reaches the build', () => {
    expect([['build', 'secret'], ['both', 'secret'], ['runtime', 'secret'], ['build', 'arg'], ['both', undefined]].map(([s, a]) => scopeLabel(s, a)))
      .toEqual(['Build secret', 'Build secret + runtime', 'Runtime', 'Build', 'Build + runtime'])
  })
  test('the Dockerfile line names the secret and sets it as an environment variable of that step', () => {
    expect(secretMount('NPM_TOKEN')).toBe('RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN ...')
  })
})

describe('buildNameProblem (the same names the API refuses)', () => {
  test.each(['PATH', 'HOME', 'LANG', 'TZ', 'LD_PRELOAD', 'DOCKER_HOST', 'DOCKER_CONFIG', 'BUILDKIT_PROGRESS', 'BUILDX_BUILDER', 'COMPOSE_FILE', 'XDG_CONFIG_HOME', 'LC_ALL'])('%s is refused', (n) => {
    expect(buildNameProblem(n)).toMatch(/cannot be used at build time/)
  })
  test.each(['VITE_API_URL', 'NEXT_PUBLIC_KEY', 'NODE_ENV', 'NPM_TOKEN', 'HTTP_PROXY', 'MYDOCKER_X', ''])('%s is fine', (n) => {
    expect(buildNameProblem(n)).toBeNull()
  })
  test('spaces around the name do not hide it', () => {
    expect(buildNameProblem('  PATH  ')).not.toBeNull()
  })
})

describe('scopeBadgeClass', () => {
  test('anything that reaches the build is highlighted, runtime-only (and unknown) is muted', () => {
    expect(['build', 'both'].every((s) => scopeBadgeClass(s).includes('text-primary'))).toBe(true)
    expect(['runtime', undefined, 'x'].every((s) => scopeBadgeClass(s).includes('text-muted-foreground'))).toBe(true)
  })
})

describe('nameFormatProblem (the same shape as the API)', () => {
  test.each(['A', '_x', 'DATABASE_URL', 'a1', 'x'.repeat(128)])('%s is fine', (n) => expect(nameFormatProblem(n)).toBeNull())
  test.each(['', '1A', 'a-b', 'a b', 'ä', 'x'.repeat(129), undefined, null])('%s is refused', (n) => expect(nameFormatProblem(n)).toMatch(/letters, digits and underscore/))
})
