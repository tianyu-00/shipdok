import { render } from '@testing-library/react'
import { ThemeProvider } from 'next-themes'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'

/**
 * Replaces fetch with a fake API. `routes` maps "METHOD /api/path" to a value, or to a function
 * (request) => value | Response-like. A thrown { status, body } becomes an error answer.
 * Returns the list of calls made, so a test can assert what was sent.
 */
export function mockApi(routes) {
  const calls = []
  const fake = vi.fn(async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = String(url)
    const bare = path.split('?')[0]
    const call = { method, path, bare, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${bare}`]
    if (handler === undefined) return respond(404, { error: `No fake for ${method} ${path}` })
    try {
      const out = typeof handler === 'function' ? await handler(call) : handler
      if (out instanceof FakeStatus) return respond(out.status, out.body)
      return out === null ? respond(204, null) : respond(200, out)
    } catch (err) {
      if (err && typeof err.status === 'number') return respond(err.status, err.body ?? {})
      throw err
    }
  })
  vi.stubGlobal('fetch', fake)
  return { calls, fake, called: (method, bare) => calls.filter((c) => c.method === method && c.bare === bare) }
}

export class FakeStatus {
  constructor(status, body) { this.status = status; this.body = body }
}
export const answer = (status, body) => new FakeStatus(status, body)

function respond(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => { if (body === null) throw new Error('no body'); return body },
  }
}

export function renderWithProviders(ui, { route = '/' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } } })
  const view = render(
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="shipdok-theme">
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  )
  return { ...view, client }
}
