import { describe, test, expect } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { useRepos, useAuth } from './queries'
import { mockApi, answer } from '@/test/utils'

const wrap = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }) => createElement(QueryClientProvider, { client }, children)
}

describe('repositories', () => {
  test('no GitHub App configured (501) is an answer, not an error', async () => {
    mockApi({ 'GET /api/github/repos': answer(501, { error: 'GitHub App is not configured' }) })
    const { result } = renderHook(() => useRepos(), { wrapper: wrap() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ available: false, repos: [] })
  })

  test('other failures stay errors', async () => {
    mockApi({ 'GET /api/github/repos': answer(502, { error: 'Could not list repositories from GitHub' }) })
    const { result } = renderHook(() => useRepos(), { wrapper: wrap() })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })

  test('a list is passed on', async () => {
    mockApi({ 'GET /api/github/repos': { repos: [{ fullName: 'a/b' }] } })
    const { result } = renderHook(() => useRepos(), { wrapper: wrap() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ available: true, repos: [{ fullName: 'a/b' }] })
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
