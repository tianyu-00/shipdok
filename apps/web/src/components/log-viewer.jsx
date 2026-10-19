import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { parseLogLine } from '@/lib/format'
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
export function LogViewer({ path, kind, pollMs = 2000, maxLines = DEFAULT_MAX_LINES, className, emptyText = 'Nothing has been logged yet.' }) {
  const [lines, setLines] = useState([])
  const [state, setState] = useState({ loading: true, error: null, missing: false, truncated: false, complete: false, hidden: false })
  const [autoScroll, setAutoScroll] = useState(true)
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

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span aria-live="polite">
          {state.loading ? 'Loading…' : state.complete ? 'Finished' : state.missing ? '' : 'Following'}
          {state.truncated && ' · the size limit was reached, later output was not stored'}
          {state.hidden && ' · older lines are hidden'}
        </span>
        <span className="flex items-center gap-2">
          <Switch id={`follow-${path}-${kind}`} checked={autoScroll} onCheckedChange={setAutoScroll} />
          <Label htmlFor={`follow-${path}-${kind}`} className="text-xs">Scroll to newest</Label>
        </span>
      </div>
      <div
        ref={box}
        onScroll={onScroll}
        role="log"
        aria-label="Log output"
        className="h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-5"
      >
        {state.error && <p className="text-destructive">{state.error}</p>}
        {!state.loading && !state.error && lines.length === 0 && <p className="text-muted-foreground">{emptyText}</p>}
        {lines.map((l) => (
          <div key={l.id} className="flex gap-3" data-stream={l.stream}>
            <span className="shrink-0 select-none text-muted-foreground">{clock(l.time)}</span>
            <span className={cn('whitespace-pre-wrap break-all', l.stream === 'stderr' && 'text-destructive', l.stream === 'shipdok' && 'text-info')}>{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
