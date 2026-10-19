import { describe, test, expect, vi, afterEach } from 'vitest'
import { api, ApiError, setUnauthorizedHandler } from './api'

const reply = (status, body) => ({ ok: status < 300, status, json: async () => { if (body === undefined) throw new Error('empty'); return body } })
afterEach(() => { vi.unstubAllGlobals(); setUnauthorizedHandler(null) })

describe('api()', () => {
  test('sends JSON with the session cookie and returns the parsed answer', async () => {
    const fetchMock = vi.fn(async () => reply(200, { ok: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await api('/apps', { method: 'POST', body: { name: 'x' } })).toEqual({ ok: 1 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/apps')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"name":"x"}', headers: { 'Content-Type': 'application/json' } })
  })

  test('a GET sends no body and no content type', async () => {
    const fetchMock = vi.fn(async () => reply(200, []))
    vi.stubGlobal('fetch', fetchMock)
    await api('/apps')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.body).toBeUndefined()
    expect(init.headers).toBeUndefined()
  })

  test('an error answer becomes an ApiError with the server\'s message and the whole body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(409, { error: 'Disk full', code: 'disk_critical', disk: { level: 'critical' } })))
    const err = await api('/x').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect([err.status, err.message, err.body.code]).toEqual([409, 'Disk full', 'disk_critical'])
  })

  test('an error with no JSON still has a readable message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(502)))
    const err = await api('/x').catch((e) => e)
    expect(err.message).toMatch(/failed \(502\)/)
  })

  test('a refused origin says which address was refused and how to fix it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(403, { error: 'Origin not allowed' })))
    const err = await api('/auth/login', { method: 'POST', body: {} }).catch((e) => e)
    expect(err.status).toBe(403)
    expect(err.message).toContain(window.location.origin)
    expect(err.message).toContain('WEB_ORIGIN')
  })

  test('other 403 answers keep the server\'s own message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(403, { error: 'Invalid setup token' })))
    const err = await api('/auth/setup', { method: 'POST', body: {} }).catch((e) => e)
    expect(err.message).toBe('Invalid setup token')
  })

  test('204 is null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204, json: async () => { throw new Error('none') } })))
    expect(await api('/x', { method: 'DELETE' })).toBeNull()
  })

  test('a network failure says the API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const err = await api('/x').catch((e) => e)
    expect([err.status, err.message]).toEqual([0, expect.stringMatching(/cannot reach/i)])
  })

  test('an aborted request is passed on as an abort, not as a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }))
    await expect(api('/x')).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('401 on a normal request tells the app the session ran out', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'Not authenticated' })))
    await api('/apps').catch(() => {})
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('401 on /auth/* (a wrong password) is NOT a session expiry', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'Invalid username or password' })))
    await api('/auth/login', { method: 'POST', body: {} }).catch(() => {})
    expect(handler).not.toHaveBeenCalled()
  })
})
