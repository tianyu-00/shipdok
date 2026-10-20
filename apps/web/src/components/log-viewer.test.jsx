import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LogViewer } from './log-viewer'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { line } from '@/test/fixtures'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => { vi.clearAllMocks(); vi.restoreAllMocks() })

const chunk = (text, over = {}) => ({ text, offset: 0, nextOffset: text.length, size: text.length, complete: false, truncated: false, ...over })
const lines = () => [...document.querySelectorAll('[role="log"] [data-stream]')].map((el) => el.textContent)

describe('reading a log', () => {
  test('loads the last lines first, with their time, and colours them by what they say', async () => {
    const text = line(1) + line(2, 'stderr', 'Error: boom') + line(3, 'shipdok', 'Deployment succeeded') + line(4, 'stderr', '#5 [2/4] RUN npm ci') + line(5, 'stderr', 'npm warn deprecated x')
    mockApi({ 'GET /api/x/logs': chunk(text, { complete: true }) })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} />)
    await screen.findByText('Error: boom')
    expect(lines()).toEqual(['12:00:01line 1', '12:00:02Error: boom', '12:00:03Deployment succeeded', '12:00:04#5 [2/4] RUN npm ci', '12:00:05npm warn deprecated x'])
    // a darker shade on the light console, the brighter one under `dark:`
    expect(screen.getByText('Error: boom')).toHaveClass('text-red-600', 'dark:text-red-400')
    expect(screen.getByText('Deployment succeeded')).toHaveClass('text-emerald-700', 'dark:text-emerald-400')
    expect(screen.getByText('#5 [2/4] RUN npm ci')).toHaveClass('text-sky-700', 'dark:text-sky-300')
    expect(screen.getByText('npm warn deprecated x')).toHaveClass('text-amber-700', 'dark:text-amber-300')
    expect(screen.getByText('line 1')).toHaveClass('text-zinc-800', 'dark:text-zinc-200')
  })

  test('ordinary progress on stderr is not painted as an error', async () => {
    mockApi({ 'GET /api/x/logs': chunk(line(1, 'stderr', '#1 transferring dockerfile: 235B done'), { complete: true }) })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} />)
    expect(await screen.findByText('#1 transferring dockerfile: 235B done')).not.toHaveClass('text-red-400')
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
    await screen.findByText('Live')
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

describe('the console around the log', () => {
  const show = async (text, props = {}, over = {}) => {
    mockApi({ 'GET /api/x/logs': chunk(text, { complete: true, ...over }) })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} {...props} />)
    await screen.findByRole('log')
    await waitFor(() => expect(lines().length).toBeGreaterThan(0))
  }
  const text5 = line(1, 'stdout', 'alpha one') + line(2, 'stdout', 'beta two') + line(3, 'stderr', 'Error: gamma') + line(4, 'stdout', 'alpha again') + line(5, 'stdout', 'delta')

  test('shows a title, the state and how many lines there are', async () => {
    await show(text5, { title: 'a1b2c3d · 2 min ago' })
    expect(screen.getByText('a1b2c3d · 2 min ago')).toBeInTheDocument()
    expect(screen.getByText('Finished')).toBeInTheDocument()
    expect(screen.getByText('5 lines')).toBeInTheDocument()
  })

  test('a log that is still being written says it is live', async () => {
    mockApi({ 'GET /api/x/logs': () => chunk(line(1), { complete: false }) })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} />)
    expect(await screen.findByText('Live')).toBeInTheDocument()
    expect(screen.queryByText('Finished')).toBeNull()
  })

  const find = () => screen.getByLabelText('Find in log')
  const current = () => [...document.querySelectorAll('[role="log"] [data-current]')].map((el) => el.textContent)
  const marks = () => [...document.querySelectorAll('[role="log"] mark')]

  test('searching keeps every line on screen, highlights each match and says which one is current', async () => {
    await show(text5)
    await userEvent.type(find(), 'ALPHA') // ignoring case
    expect(lines()).toHaveLength(5) // nothing is hidden: the lines around a match stay readable
    expect(marks().map((m) => m.textContent)).toEqual(['alpha', 'alpha'])
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    expect(current()).toEqual(['12:00:01alpha one'])
  })

  test('the current match is highlighted more strongly than the others', async () => {
    await show(text5)
    await userEvent.type(find(), 'alpha')
    const [first, second] = marks()
    expect(first).toHaveClass('bg-yellow-300', 'dark:bg-yellow-400') // the current one
    expect(second).toHaveClass('bg-yellow-200', 'dark:bg-yellow-400/30')
    expect(first).not.toHaveClass('bg-yellow-200')
  })

  test('the line text is unchanged by the highlighting', async () => {
    await show(text5)
    const before = lines()
    await userEvent.type(find(), 'gam')
    expect(lines()).toEqual(before)
  })

  test('Enter goes to the next match and wraps round; Shift+Enter goes back', async () => {
    await show(text5)
    await userEvent.type(find(), 'alpha')
    await userEvent.keyboard('{Enter}')
    expect(current()).toEqual(['12:00:04alpha again'])
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    expect(current()).toEqual(['12:00:01alpha one']) // back to the first
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    expect(current()).toEqual(['12:00:04alpha again']) // and backwards from the first wraps to the last
  })

  test('the arrow buttons step through the matches too', async () => {
    await show(text5)
    await userEvent.type(find(), 'alpha')
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }))
    expect(current()).toEqual(['12:00:04alpha again'])
    await userEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(current()).toEqual(['12:00:01alpha one'])
  })

  test('no match: it says so, all lines stay, and there is nowhere to step', async () => {
    await show(text5)
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled() // nothing searched yet
    await userEvent.type(find(), 'zzz')
    expect(screen.getByText('No matches')).toBeInTheDocument()
    expect(lines()).toHaveLength(5)
    expect(marks()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeDisabled()
  })

  test('Escape and the clear button remove the search', async () => {
    await show(text5)
    await userEvent.type(find(), 'alpha')
    await userEvent.keyboard('{Escape}')
    expect(find()).toHaveValue('')
    expect(marks()).toHaveLength(0)
    expect(screen.queryByText(/of 2/)).toBeNull()
    await userEvent.type(find(), 'delta')
    await userEvent.click(screen.getByRole('button', { name: 'Clear the search' }))
    expect(find()).toHaveValue('')
    expect(current()).toEqual([])
  })

  test('a search of only spaces is no search', async () => {
    await show(text5)
    await userEvent.type(find(), '   ')
    expect(marks()).toHaveLength(0)
    expect(screen.queryByText('No matches')).toBeNull()
  })

  test('searching turns following off, so new lines do not pull the view away, and "Latest" brings it back', async () => {
    await show(text5)
    expect(screen.getByRole('switch', { name: 'Scroll to newest' })).toBeChecked()
    await userEvent.type(find(), 'alpha')
    expect(screen.getByRole('switch', { name: 'Scroll to newest' })).not.toBeChecked()
    await userEvent.click(await screen.findByRole('button', { name: 'Jump to the newest line' }))
    expect(screen.getByRole('switch', { name: 'Scroll to newest' })).toBeChecked()
  })

  describe('scrolling to the match', () => {
    const geometry = () => {
      // jsdom has no layout: say where each line is (20px each) and how tall the console is (100px).
      vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function () { return this.dataset?.line === undefined ? 0 : Number(this.dataset.line) * 20 })
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20)
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    }

    test('the current match is brought to the middle of the console, and stepping moves it', async () => {
      geometry()
      await show(text5)
      const box = screen.getByRole('log')
      await userEvent.type(find(), 'delta') // the line with id 4: 4*20 - 100/2 + 20/2 = 40
      expect(box.scrollTop).toBe(40)
      await userEvent.clear(find())
      await userEvent.type(find(), 'alpha')
      expect(box.scrollTop).toBe(0) // the first match is at the top: it cannot go below zero
      await userEvent.keyboard('{Enter}') // "alpha again" is line id 3: 60 - 50 + 10
      expect(box.scrollTop).toBe(20)
    })

    test('lines that arrive while searching do not move the view, but are searched too', async () => {
      geometry()
      let release
      const gate = new Promise((resolve) => { release = resolve }) // the new line is held back until the test has scrolled
      let served = false
      const more = { text: line(6, 'stdout', 'late alpha'), offset: text5.length, nextOffset: text5.length + 50, size: text5.length + 50, complete: false, truncated: false }
      const quiet = { text: '', offset: more.nextOffset, nextOffset: more.nextOffset, size: more.nextOffset, complete: false, truncated: false }
      mockApi({ 'GET /api/x/logs': async (c) => {
        if (c.path.includes('tail=')) return chunk(text5, { complete: false })
        if (!served) { await gate; served = true; return more }
        return quiet
      } })
      renderWithProviders(<LogViewer path="/x/logs" pollMs={20} />)
      await waitFor(() => expect(lines()).toHaveLength(5))
      await userEvent.type(find(), 'alpha')
      const box = screen.getByRole('log')
      box.scrollTop = 7 // wherever the person was reading
      release() // now the new line arrives
      await waitFor(() => expect(lines()).toHaveLength(6))
      await waitFor(() => expect(screen.getByText('1 of 3')).toBeInTheDocument()) // the new line is a match as well
      expect(box.scrollTop).toBe(7) // and the view stayed where it was
      expect(current()).toEqual(['12:00:01alpha one'])
    })
  })

  describe('stepping through three matches', () => {
    const text3 = line(1, 'stdout', 'item a1') + line(2, 'stdout', 'item a2') + line(3, 'stdout', 'item a3')

    test('Shift+Enter goes backwards, round the start to the last match', async () => {
      await show(text3)
      await userEvent.type(find(), 'item')
      expect(screen.getByText('1 of 3')).toBeInTheDocument()
      await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
      expect(screen.getByText('3 of 3')).toBeInTheDocument()
      await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
      expect(screen.getByText('2 of 3')).toBeInTheDocument()
    })

    test('Enter goes forwards through all three and round to the first', async () => {
      await show(text3)
      await userEvent.type(find(), 'item')
      for (const n of ['2 of 3', '3 of 3', '1 of 3']) {
        await userEvent.keyboard('{Enter}')
        expect(screen.getByText(n)).toBeInTheDocument()
      }
    })

    test('stepping turns following off again, if it was switched back on', async () => {
      await show(text3)
      await userEvent.type(find(), 'item')
      await userEvent.click(screen.getByRole('switch', { name: 'Scroll to newest' })) // following on again
      expect(screen.getByRole('switch', { name: 'Scroll to newest' })).toBeChecked()
      await userEvent.click(screen.getByRole('button', { name: 'Next match' }))
      expect(screen.getByRole('switch', { name: 'Scroll to newest' })).not.toBeChecked()
    })

    test('changing the text starts again at the first match', async () => {
      await show(text3)
      await userEvent.type(find(), 'item')
      await userEvent.keyboard('{Enter}{Enter}')
      expect(screen.getByText('3 of 3')).toBeInTheDocument()
      await userEvent.type(find(), ' a') // still three matches, but it is a new search
      expect(screen.getByText('1 of 3')).toBeInTheDocument()
    })
  })

  test('copy puts every line on the clipboard, with its time, whatever is searched', async () => {
    const written = []
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (t) => { written.push(t) } } })
    await show(text5)
    await userEvent.type(find(), 'alpha')
    await userEvent.click(screen.getByRole('button', { name: 'Copy the log' }))
    await waitFor(() => expect(written).toHaveLength(1))
    expect(written[0].split('\n')).toEqual(['12:00:01 alpha one', '12:00:02 beta two', '12:00:03 Error: gamma', '12:00:04 alpha again', '12:00:05 delta'])
    expect(toasts.success).toHaveBeenCalledWith('Copied 5 lines')
  })

  test('when the browser refuses to copy, it says so', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async () => { throw new Error('denied') } } })
    await show(text5)
    await userEvent.click(screen.getByRole('button', { name: 'Copy the log' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalled())
  })

  test('download saves every loaded line in the log file\'s format, under the given name', async () => {
    let blob
    const created = vi.fn((b) => { blob = b; return 'blob:fake' })
    const revoked = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked }))
    const names = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { names.push(this.download) })
    await show(text5, { filename: 'build-a1b2c3d.log' })
    await userEvent.click(screen.getByRole('button', { name: 'Download the log' }))
    expect(names).toEqual(['build-a1b2c3d.log'])
    expect((await blob.text()).split('\n').filter(Boolean)).toEqual([
      '2026-10-19T12:00:01.000Z stdout alpha one', '2026-10-19T12:00:02.000Z stdout beta two', '2026-10-19T12:00:03.000Z stderr Error: gamma',
      '2026-10-19T12:00:04.000Z stdout alpha again', '2026-10-19T12:00:05.000Z stdout delta',
    ])
    expect(revoked).toHaveBeenCalledWith('blob:fake')
    click.mockRestore()
  })

  test('copy and download are off while there is nothing to copy', async () => {
    mockApi({ 'GET /api/x/logs': chunk('', { complete: true }) })
    renderWithProviders(<LogViewer path="/x/logs" pollMs={10} />)
    await screen.findByText('Nothing has been logged yet.')
    expect(screen.getByRole('button', { name: 'Copy the log' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Download the log' })).toBeDisabled()
  })

  test('"Jump to the newest line" appears only after scrolling away, and turns following back on', async () => {
    await show(text5)
    expect(screen.queryByRole('button', { name: 'Jump to the newest line' })).toBeNull()
    await userEvent.click(screen.getByRole('switch', { name: 'Scroll to newest' })) // switch following off
    const jump = await screen.findByRole('button', { name: 'Jump to the newest line' })
    await userEvent.click(jump)
    expect(screen.getByRole('switch', { name: 'Scroll to newest' })).toBeChecked()
    expect(screen.queryByRole('button', { name: 'Jump to the newest line' })).toBeNull()
  })

  test('the console follows the theme: pale on a light page, dark on a dark one', async () => {
    await show(text5)
    const panel = screen.getByRole('log').parentElement.parentElement
    expect(panel).toHaveClass('bg-zinc-50', 'text-zinc-800', 'border-zinc-200') // light
    expect(panel).toHaveClass('dark:bg-zinc-950', 'dark:text-zinc-200', 'dark:border-zinc-800') // dark
    expect(panel.firstElementChild).toHaveClass('bg-zinc-100', 'dark:bg-zinc-900') // the title bar too
  })
})
