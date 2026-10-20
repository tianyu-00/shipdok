import { describe, test, expect } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { useRepos, useBranches, useAuth } from './queries'
import { mockApi, answer } from '@/test/utils'

const wrap = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }) => createElement(QueryClientProvider, { client }, children)
}

describe('repositories', () => {
  const APP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const URL = `GET /api/github/apps/${APP}/repos`

  test('no GitHub app chosen: nothing is asked and the query waits', async () => {
    const api = mockApi({})
    const { result } = renderHook(() => useRepos(undefined), { wrapper: wrap() })
    await new Promise((r) => setTimeout(r, 30))
    expect(result.current.fetchStatus).toBe('idle')
    expect(api.calls ?? []).toHaveLength(0)
  })

  test.each([[404], [409]])('a GitHub app that is gone or unreadable (%i) is an answer, not an error', async (status) => {
    mockApi({ [URL]: answer(status, { error: 'x' }) })
    const { result } = renderHook(() => useRepos(APP), { wrapper: wrap() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ available: false, repos: [] })
  })

  test('other failures stay errors', async () => {
    mockApi({ [URL]: answer(502, { error: 'Could not list repositories from GitHub' }) })
    const { result } = renderHook(() => useRepos(APP), { wrapper: wrap() })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })

  test('a list is passed on', async () => {
    mockApi({ [URL]: { repos: [{ fullName: 'a/b' }] } })
    const { result } = renderHook(() => useRepos(APP), { wrapper: wrap() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ available: true, repos: [{ fullName: 'a/b' }] })
  })

  test('each GitHub app has its own list', async () => {
    const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    mockApi({ [URL]: { repos: [{ fullName: 'mine/one' }] }, [`GET /api/github/apps/${OTHER}/repos`]: { repos: [{ fullName: 'theirs/two' }] } })
    const w = wrap()
    const a = renderHook(() => useRepos(APP), { wrapper: w })
    const b = renderHook(() => useRepos(OTHER), { wrapper: w })
    await waitFor(() => expect(a.result.current.isSuccess && b.result.current.isSuccess).toBe(true))
    expect(a.result.current.data.repos[0].fullName).toBe('mine/one')
    expect(b.result.current.data.repos[0].fullName).toBe('theirs/two')
  })
})

describe('branches', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  test('the same repository through two GitHub apps is two different answers, each asked through its own app', async () => {
    const api = mockApi({
      [`GET /api/github/branches?repo=o%2Fr&app=${A}`]: { defaultBranch: 'main', branches: ['main'], truncated: false },
      [`GET /api/github/branches?repo=o%2Fr&app=${B}`]: { defaultBranch: 'dev', branches: ['dev'], truncated: false },
      'GET /api/github/branches?repo=o%2Fr': { defaultBranch: 'anon', branches: ['anon'], truncated: false },
    })
    const w = wrap()
    const a = renderHook(() => useBranches('o/r', A), { wrapper: w })
    const b = renderHook(() => useBranches('o/r', B), { wrapper: w })
    const none = renderHook(() => useBranches('o/r', undefined), { wrapper: w })
    await waitFor(() => expect(a.result.current.isSuccess && b.result.current.isSuccess && none.result.current.isSuccess).toBe(true))
    expect([a, b, none].map((h) => h.result.current.data.defaultBranch)).toEqual(['main', 'dev', 'anon'])
    expect(api.called('GET', '/api/github/branches')).toHaveLength(3)
  })

  test('nothing is asked for something that is not a repository', async () => {
    const api = mockApi({})
    renderHook(() => useBranches('owner', A), { wrapper: wrap() })
    await new Promise((r) => setTimeout(r, 30))
    expect(api.calls).toHaveLength(0)
  })
})

describe('the session', () => {
  test('not logged in: nothing else is asked, so there is no 401 noise', async () => {
    const api = mockApi({ 'GET /api/auth/status': { needsSetup: false, authenticated: false } })
    const { result } = renderHook(() => useAuth(), { wrapper: wrap() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ needsSetup: false, authenticated: false, username: null })
    expect(api.called('GET', '/api/auth/me')).toHaveLength(0)
  })
})
