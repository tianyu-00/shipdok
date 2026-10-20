import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ChevronDown, ChevronUp, Copy, Download, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { parseLogLine } from '@/lib/format'
import { lineTone, splitMatches, TONE_CLASS } from '@/lib/logtone'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

const INITIAL_TAIL = 500
const DEFAULT_MAX_LINES = 5000
const PAGE_BYTES = 64 * 1024

const clock = (iso) => (iso ? iso.slice(11, 19) : '')

/**
 * Shows a log from the API and keeps following it: first the last lines, then whatever is added, by byte offset.
 * `path` is the log endpoint ('/apps/:id/logs' or '/deployments/:id/logs'); `kind` picks which log of it.
 * Stops polling when the API says the log is finished and fully read. A log that restarts from empty (the app was
 * restarted) is noticed and loaded again from the top. To show a different log, give the component a new `key`: it starts
 * from scratch on mount.
 */
export function LogViewer({ path, kind, pollMs = 2000, maxLines = DEFAULT_MAX_LINES, className, emptyText = 'Nothing has been logged yet.', title, filename = 'log.txt' }) {
  const [lines, setLines] = useState([])
  const [state, setState] = useState({ loading: true, error: null, missing: false, truncated: false, complete: false, hidden: false })
  const [autoScroll, setAutoScroll] = useState(true)
  const [findText, setFindText] = useState('') // the text being looked for
  const [cursor, setCursor] = useState(0) // which match is the current one
  const [nav, setNav] = useState(0) // counts every typing or stepping, so the view scrolls to the current match then and only then
  const box = useRef(null)
  const serial = useRef(0)

  const query = useCallback((extra) => {
    const qs = new URLSearchParams(extra)
    if (kind) qs.set('kind', kind)
    return `${path}?${qs}`
  }, [path, kind])

  useEffect(() => {
    const mine = ++serial.current
    const alive = () => serial.current === mine
    let timer
    let offset = null
    let nextId = 0
    let total = 0 // lines received since the log was loaded (more than maxLines means the oldest are dropped)

    const toLines = (text) => text.split('\n').filter((l) => l !== '').map((l) => ({ id: nextId++, ...parseLogLine(l) }))

    async function loadTail() {
      const res = await api(query({ tail: INITIAL_TAIL }))
      if (!alive()) return null
      offset = res.nextOffset
      const first = toLines(res.text)
      total = first.length
      setLines(first)
      return res
    }

    async function step() {
      let res
      try {
        if (offset === null) {
          res = await loadTail()
        } else {
          res = await api(query({ offset, limit: PAGE_BYTES }))
          if (!alive()) return
          if (res.nextOffset < offset) { // the log began again from empty: start over
            res = await loadTail()
          } else {
            offset = res.nextOffset
            if (res.text) {
              const added = toLines(res.text)
              total += added.length
              if (total > maxLines) setState((s) => (s.hidden ? s : { ...s, hidden: true }))
              setLines((old) => {
                const all = old.concat(added)
                return all.length > maxLines ? all.slice(all.length - maxLines) : all
              })
            }
          }
        }
      } catch (err) {
        if (!alive()) return
        if (err instanceof ApiError && err.status === 404) {
          setState((s) => ({ ...s, loading: false, missing: true, error: null }))
          timer = setTimeout(step, pollMs * 2) // maybe it appears later (the app has not printed anything yet)
          return
        }
        setState((s) => ({ ...s, loading: false, error: err.message }))
        timer = setTimeout(step, pollMs * 2)
        return
      }
      if (!alive() || !res) return
      setState((s) => ({ ...s, loading: false, missing: false, error: null, truncated: res.truncated, complete: res.complete }))
      if (res.complete) return // finished and fully read: nothing more will come
      const more = res.nextOffset < res.size // there is already more to read: do not wait
      timer = setTimeout(step, more ? 0 : pollMs)
    }

    step()
    return () => { serial.current += 1; clearTimeout(timer) }
  }, [query, pollMs, maxLines])

  useEffect(() => {
    const el = box.current
    if (autoScroll && el) el.scrollTop = el.scrollHeight
  }, [lines, autoScroll])

  const onScroll = () => {
    const el = box.current
    if (!el) return
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll((was) => (was === atEnd ? was : atEnd))
  }

  // Find, like Ctrl+F: every line stays visible, every match is highlighted, and the current one is scrolled to.
  const needle = findText.trim()
  const matchIds = useMemo(() => {
    if (!needle) return []
    const low = needle.toLowerCase()
    return lines.filter((l) => l.message.toLowerCase().includes(low)).map((l) => l.id)
  }, [lines, needle])
  const current = matchIds.length ? Math.min(cursor, matchIds.length - 1) : -1 // lines can be dropped while following
  const currentId = current >= 0 ? matchIds[current] : null
  const matchSet = useMemo(() => new Set(matchIds), [matchIds])

  const find = (text) => {
    setFindText(text)
    setCursor(0)
    setNav((n) => n + 1)
    if (text.trim()) setAutoScroll(false) // new lines must not pull the view away from what was found
  }
  const step = (delta) => {
    if (!matchIds.length) return
    setCursor((current + delta + matchIds.length) % matchIds.length)
    setNav((n) => n + 1)
    setAutoScroll(false)
  }
  const onFindKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
    else if (e.key === 'Escape' && findText) { e.preventDefault(); find('') }
  }

  // Bring the current match to the middle of the console, when the person searched or stepped (not each time new lines arrive).
  useEffect(() => {
    const box_ = box.current
    const el = currentId === null ? null : box_?.querySelector(`[data-line="${currentId}"]`)
    if (el) box_.scrollTop = Math.max(0, el.offsetTop - box_.clientHeight / 2 + el.offsetHeight / 2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav])

  const copy = async () => {
    const text = lines.map((l) => `${clock(l.time)} ${l.message}`.trim()).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`Copied ${lines.length} line${lines.length === 1 ? '' : 's'}`)
    } catch {
      toast.error('Could not copy: the browser did not allow it')
    }
  }

  // The lines loaded in this page (the newest ones, up to the page limit), in the same format the log file has.
  const download = () => {
    const text = `${lines.map((l) => `${l.time ?? ''} ${l.stream} ${l.message}`.trim()).join('\n')}\n`
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const jumpToLatest = () => {
    setAutoScroll(true)
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const status = state.loading ? 'Loading…' : state.complete ? 'Finished' : state.missing ? '' : 'Live'
  const iconButton = 'inline-flex size-7 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:opacity-40 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:focus-visible:ring-zinc-500'

  // A console that follows the theme: light on a light page, dark on a dark one.
  return (
    <div className={cn('overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-800 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-200 bg-zinc-100 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        <span className="flex min-w-0 items-center gap-2" aria-live="polite">
          <span className={cn('size-2 shrink-0 rounded-full', state.complete ? 'bg-zinc-400 dark:bg-zinc-500' : state.loading || state.missing ? 'bg-zinc-300 dark:bg-zinc-600' : 'animate-pulse bg-emerald-500')} aria-hidden="true" />
          {title && <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">{title}</span>}
          <span className="whitespace-nowrap">{status}</span>
          {lines.length > 0 && <span className="whitespace-nowrap text-zinc-500">{lines.length} lines</span>}
          {state.truncated && <span className="text-amber-700 dark:text-amber-300">the size limit was reached, later output was not stored</span>}
          {state.hidden && <span className="text-amber-700 dark:text-amber-300">older lines are hidden</span>}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1">
            <span className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
              <input
                type="text" value={findText} onChange={(e) => find(e.target.value)} onKeyDown={onFindKey} placeholder="Find in log" aria-label="Find in log" autoComplete="off" spellCheck={false}
                className="h-7 w-32 rounded border border-zinc-300 bg-white pl-7 pr-7 text-xs text-zinc-900 placeholder:text-zinc-400 focus-visible:border-zinc-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 sm:w-40"
              />
              {findText && (
                <button type="button" aria-label="Clear the search" onClick={() => find('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200"><X className="size-3.5" /></button>
              )}
            </span>
            {needle && <span className="min-w-14 whitespace-nowrap text-center text-zinc-500 dark:text-zinc-400" aria-live="polite">{matchIds.length ? `${current + 1} of ${matchIds.length}` : 'No matches'}</span>}
            <button type="button" className={iconButton} aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={matchIds.length === 0} onClick={() => step(-1)}><ChevronUp className="size-4" /></button>
            <button type="button" className={iconButton} aria-label="Next match" title="Next match (Enter)" disabled={matchIds.length === 0} onClick={() => step(1)}><ChevronDown className="size-4" /></button>
          </span>
          <button type="button" className={iconButton} aria-label="Copy the log" title="Copy the log" disabled={lines.length === 0} onClick={copy}><Copy className="size-4" /></button>
          <button type="button" className={iconButton} aria-label="Download the log" title="Download the lines loaded here" disabled={lines.length === 0} onClick={download}><Download className="size-4" /></button>
          <span className="ml-1 flex items-center gap-2">
            <Switch id={`follow-${path}-${kind}`} checked={autoScroll} onCheckedChange={setAutoScroll} />
            <Label htmlFor={`follow-${path}-${kind}`} className="text-xs font-normal text-zinc-500 dark:text-zinc-400">Scroll to newest</Label>
          </span>
        </span>
      </div>
      <div className="relative">
        <div
          ref={box}
          onScroll={onScroll}
          role="log"
          aria-label="Log output"
          className="relative h-80 overflow-auto p-3 font-mono text-xs leading-5 sm:h-96"
        >
          {state.error && <p className="text-red-600 dark:text-red-400">{state.error}</p>}
          {!state.loading && !state.error && lines.length === 0 && <p className="text-zinc-500">{emptyText}</p>}
          {lines.map((l) => (
            <div key={l.id} data-line={l.id} data-stream={l.stream} data-current={l.id === currentId ? 'true' : undefined} className={cn('-mx-3 flex gap-3 px-3', l.id === currentId && 'bg-yellow-400/25 dark:bg-yellow-400/15')}>
              <span className="shrink-0 select-none text-zinc-400 dark:text-zinc-600">{clock(l.time)}</span>
              <span className={cn('min-w-0 whitespace-pre-wrap break-all', TONE_CLASS[lineTone(l.stream, l.message)])}>
                {matchSet.has(l.id)
                  ? splitMatches(l.message, needle).map((p, i) => (p.match
                    ? <mark key={i} className={cn('rounded-sm text-inherit', l.id === currentId ? 'bg-yellow-300 text-zinc-950 dark:bg-yellow-400' : 'bg-yellow-200 dark:bg-yellow-400/30')}>{p.text}</mark>
                    : p.text))
                  : l.message}
              </span>
            </div>
          ))}
        </div>
        {!autoScroll && lines.length > 0 && (
          <button
            type="button" onClick={jumpToLatest} aria-label="Jump to the newest line"
            className="absolute bottom-3 right-4 inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white/95 px-3 py-1 text-xs text-zinc-700 shadow hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <ArrowDown className="size-3.5" aria-hidden="true" />Latest
          </button>
        )}
      </div>
    </div>
  )
}
