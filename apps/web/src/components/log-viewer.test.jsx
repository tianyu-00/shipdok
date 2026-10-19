import { describe, test, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { LogViewer } from './log-viewer'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { line } from '@/test/fixtures'

const chunk = (text, over = {}) => ({ text, offset: 0, nextOffset: text.length, size: text.length, complete: false, truncated: false, ...over })
const lines = () => [...document.querySelectorAll('[role="log"] [data-stream]')].map((el) => el.textContent)

describe('reading a log', () => {
  test('loads the last lines first, with their time, and tints stderr and Shipdok\'s own lines', async () => {
    const api = mockApi({ '/api/x/logs': null })
    const text = line(1) + line(2, 'stderr', 'boom') + line(3, 'shipdok', 'Deployed')
    mockApi({ 'GET /api/x/logs': chunk(text, { complete: true }) })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} />)
    await screen.findByText('boom')
    expect(lines()).toEqual(['12:00:01line 1', '12:00:02boom', '12:00:03Deployed'])
    expect(screen.getByText('boom')).toHaveClass('text-destructive')
    expect(screen.getByText('Deployed')).toHaveClass('text-info')
    expect(screen.getByText('line 1')).not.toHaveClass('text-destructive')
    void api
  })

  test('the first request asks for the tail, the next ones continue from where the last ended', async () => {
    const queue = [chunk(line(1) + line(2), { nextOffset: 100, size: 100 }), chunk(line(3), { nextOffset: 140, size: 140 }), chunk('', { nextOffset: 140, size: 140 })]
    const api = mockApi({ 'GET /api/x/logs': () => queue.length > 1 ? queue.shift() : queue[0] })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} />)
    await screen.findByText('line 3')
    expect(lines()).toHaveLength(3)
    await waitFor(() => expect(api.calls.length).toBeGreaterThanOrEqual(3))
    const urls = api.calls.map((c) => c.path)
    expect(urls[0]).toBe('/api/x/logs?tail=500')
    expect(urls[1]).toBe('/api/x/logs?offset=100&limit=65536')
    expect(urls[2]).toBe('/api/x/logs?offset=140&limit=65536')
  })

  test('which log to read is passed on', async () => {
    const api = mockApi({ 'GET /api/apps/1/logs': chunk('', { complete: true }) })
    renderWithProviders(<LogViewer path="/apps/1/logs" kind="previous" pollMs={10} />)
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(0))
    expect(api.calls[0].path).toBe('/api/apps/1/logs?tail=500&kind=previous')
  })

  test('keeps asking while the log is open, and stops once it is finished and fully read', async () => {
    const api = mockApi({ 'GET /api/x/logs': () => chunk(line(1), { complete: true }) })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} />)
    await screen.findByText('Finished')
    const before = api.calls.length
    await new Promise((r) => setTimeout(r, 80))
    expect(api.calls.length).toBe(before)
  })

  test('an open log is followed', async () => {
    const api = mockApi({ 'GET /api/x/logs': () => chunk(line(1), { complete: false }) })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} />)
    await screen.findByText('Following')
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(3))
  })

  test('more already waiting to be read is fetched at once, without waiting for the next poll', async () => {
    const queue = [chunk(line(1), { nextOffset: 50, size: 500 }), chunk(line(2), { nextOffset: 500, size: 500, complete: true })]
    mockApi({ 'GET /api/x/logs': () => queue.shift() ?? chunk('', { nextOffset: 500, size: 500, complete: true }) })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={60_000} />)
    await screen.findByText('line 2')
  })

  test('a log that starts over from empty (the app was restarted) is loaded again from the top', async () => {
    const queue = [
      chunk(line(1) + line(2), { nextOffset: 200, size: 200 }),
      chunk('', { nextOffset: 30, size: 30 }), // the file is now shorter than where we were
      chunk(line(9, 'stdout', 'fresh start'), { nextOffset: 60, size: 60 }),
    ]
    mockApi({ 'GET /api/x/logs': () => queue.length > 1 ? queue.shift() : queue[0] })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} />)
    await screen.findByText('fresh start')
    expect(screen.queryByText('line 1')).toBeNull()
  })

  test('a log that does not exist yet says so politely and is looked for again later', async () => {
    let exists = false
    const api = mockApi({ 'GET /api/x/logs': () => { if (!exists) throw { status: 404, body: { error: 'No output has been collected for this app yet' } }; return chunk(line(1)) } })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} emptyText="Nothing yet." />)
    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    exists = true
    await screen.findByText('line 1')
    expect(api.calls.length).toBeGreaterThan(1)
  })

  test('an empty log shows the given text', async () => {
    mockApi({ 'GET /api/x/logs': chunk('', { complete: true }) })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} emptyText="There is no earlier run." />)
    expect(await screen.findByText('There is no earlier run.')).toBeInTheDocument()
  })

  test('an error is shown inside the log and polling carries on', async () => {
    let fail = true
    mockApi({ 'GET /api/x/logs': () => { if (fail) throw { status: 500, body: { error: 'Internal server error' } }; return chunk(line(1)) } })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} />)
    expect(await screen.findByText('Internal server error')).toBeInTheDocument()
    fail = false
    await screen.findByText('line 1')
    expect(screen.queryByText('Internal server error')).toBeNull()
  })

  test('says when the size limit cut the log short', async () => {
    mockApi({ 'GET /api/x/logs': chunk(line(1), { truncated: true, complete: true }) })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} />)
    expect(await screen.findByText(/size limit was reached/i)).toBeInTheDocument()
  })

  test('only the newest lines are kept in the page, and it says older ones are hidden', async () => {
    const big = Array.from({ length: 40 }, (_, i) => `2026-10-19T12:00:00.000Z stdout row ${i}\n`).join('')
    const queue = [chunk('', { nextOffset: 10, size: 10 }), chunk(big, { nextOffset: 99999, size: 99999 }), chunk(big, { nextOffset: 199999, size: 199999, complete: true })]
    mockApi({ 'GET /api/x/logs': () => queue.length > 1 ? queue.shift() : queue[0] })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} maxLines={50} />)
    await screen.findByText(/older lines are hidden/i)
    expect(lines().length).toBe(50)
    expect(screen.getAllByText('row 0', { selector: 'span' })).toHaveLength(1) // the first copy (the oldest line) was dropped
    expect(screen.getAllByText('row 39', { selector: 'span' })).toHaveLength(2)
  })

  test('showing a different log (a new key) starts clean', async () => {
    mockApi({ 'GET /api/a/logs': chunk(line(1, 'stdout', 'from A'), { complete: true }), 'GET /api/b/logs': chunk(line(1, 'stdout', 'from B'), { complete: true }) })
    const { rerender } = renderWithProviders(<LogViewer key="a" path="/a/logs" pollMs={10} />)
    await screen.findByText('from A')
    rerender(<LogViewer key="b" path="/b/logs" pollMs={10} />)
    await screen.findByText('from B')
    expect(screen.queryByText('from A')).toBeNull()
  })

  test('answers that arrive after the log was closed are ignored', async () => {
    let release
    mockApi({ 'GET /api/x/logs': () => new Promise((r) => { release = () => r(chunk(line(1, 'stdout', 'too late'))) }) })
    const { unmount } = renderWithProviders(<LogViewer path="/x/logs" pollMs={10} />)
    unmount()
    release()
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText('too late')).toBeNull()
  })
})
