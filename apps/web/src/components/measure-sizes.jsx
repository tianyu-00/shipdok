import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { api, ApiError } from '@/lib/api'
import { useVolumeSizing } from '@/lib/queries'
import { timeAgo } from '@/lib/format'

/**
 * "Measure sizes" for the persistent volumes. Docker needs seconds to add a volume up (more on a big one or a slow disk), so it is never done by itself:
 * the button asks, the worker measures in the background, and this says how it stands. When it finishes, every place that shows a size is read again.
 */
export function MeasureSizes({ className = '' }) {
  const client = useQueryClient()
  const sizing = useVolumeSizing()
  const d = sizing.data
  const ask = useMutation({
    mutationFn: () => api('/volumes/sizes', { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['volume-sizing'] }),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) client.invalidateQueries({ queryKey: ['volume-sizing'] })
      else toast.error(err.message)
    },
  })
  const busy = ask.isPending || d?.measuring === true

  // When a measurement that was running ends, the figures on the page are out of date: read them again, and say how it went.
  const wasMeasuring = useRef(false)
  useEffect(() => {
    if (d?.measuring) { wasMeasuring.current = true; return }
    if (!wasMeasuring.current || !d) return
    wasMeasuring.current = false
    for (const key of ['storage', 'volumes', 'kept-volumes']) client.invalidateQueries({ queryKey: [key] })
    if (d.error) toast.error(d.error)
    else toast.success('Volume sizes measured')
  }, [d, client])

  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      <Button type="button" variant="outline" size="sm" disabled={busy || sizing.isPending} onClick={() => ask.mutate()}>{busy ? 'Measuring…' : 'Measure sizes'}</Button>
      <span className="text-xs text-muted-foreground" aria-live="polite">
        {busy && 'Docker adds up every file, which can take a while for a big volume.'}
        {!busy && d?.error && <span role="alert" className="text-destructive">Could not measure: {d.error}</span>}
        {!busy && !d?.error && d?.finishedAt && `Measured ${timeAgo(d.finishedAt)}.`}
        {!busy && !d?.error && d && !d.finishedAt && 'Not measured yet.'}
      </span>
    </div>
  )
}
