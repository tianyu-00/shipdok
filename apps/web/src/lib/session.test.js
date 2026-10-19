import { test, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { forgetSession } from './session'

test('forgets every answer except who is (not) logged in, and marks the browser signed out', () => {
  const client = new QueryClient()
  client.setQueryData(['auth'], { needsSetup: false, authenticated: true, username: 'admin' })
  client.setQueryData(['apps'], [{ id: 1 }])
  client.setQueryData(['logins'], { logins: [] })
  forgetSession(client)
  expect(client.getQueryData(['apps'])).toBeUndefined()
  expect(client.getQueryData(['logins'])).toBeUndefined()
  expect(client.getQueryData(['auth'])).toEqual({ needsSetup: false, authenticated: false, username: null })
})
