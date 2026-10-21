import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { useOldImages } from '@/lib/queries'
import { formatBytes } from '@/lib/format'
import { bytesToGbText, gbTextToBytes } from '@/lib/old-images'
import { Field } from '@/components/field'
import { LoadError } from '@/components/states'

const WATCH_MS = 60_000 // after asking for a clean-up the figures are re-read every few seconds for this long, as each app's clean-up finishes

function Threshold({ current }) {
  const client = useQueryClient()
  const saved = bytesToGbText(current)
  const [text, setText] = useState(saved)
  const [problem, setProblem] = useState(null)
  useEffect(() => { setText(saved); setProblem(null) }, [saved])
  const save = useMutation({
    mutationFn: (bytes) => api('/images/notice', { method: 'PUT', body: { thresholdBytes: bytes } }),
    onSuccess: (data) => {
      client.setQueryData(['old-images'], data)
      toast.success(data.thresholdBytes === null ? 'No notice about old images' : `You will be told when old images reach ${formatBytes(data.thresholdBytes)}`)
    },
    onError: (err) => toast.error(err.message),
  })
  const submit = (e) => {
    e.preventDefault()
    const parsed = gbTextToBytes(text)
    if (parsed.error) { setProblem(parsed.error); return }
    setProblem(null)
    save.mutate(parsed.bytes)
  }
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit} noValidate>
      <div className="w-56">
        <Field id="old-images-threshold" label="Tell me when old images reach (GB)" error={problem}
          hint="Empty means never, which is the default. A notice then shows on the apps list and here.">
          <Input id="old-images-threshold" inputMode="decimal" placeholder="never" aria-invalid={problem ? true : undefined} value={text} onChange={(e) => { setText(e.target.value); setProblem(null) }} />
        </Field>
      </div>
      <Button type="submit" variant="outline" disabled={text.trim() === saved || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
    </form>
  )
}

/**
 * The old images of every app together. Each app keeps its live version and a number of earlier ones (its Images tab); everything older is "old".
 * One button cleans every app, one switch sets the automatic clean-up for all of them, and a size can be set at which the dashboard says so.
 */
export default function OldImagesCard() {
  const old = useOldImages()
  const client = useQueryClient()
  const [asking, setAsking] = useState(false)
  const [watching, setWatching] = useState(false)

  useEffect(() => {
    if (!watching) return undefined
    const every = setInterval(() => { client.invalidateQueries({ queryKey: ['old-images'] }); client.invalidateQueries({ queryKey: ['storage'] }) }, 3000)
    const stop = setTimeout(() => setWatching(false), WATCH_MS)
    return () => { clearInterval(every); clearTimeout(stop) }
  }, [watching, client])

  const clean = useMutation({
    mutationFn: () => api('/images/prune', { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(r.queued === 0 ? 'There are no apps to clean up' : r.queued < r.apps ? `Clean-up queued for ${r.queued} of ${r.apps} apps` : `Clean-up queued for ${r.queued} app${r.queued === 1 ? '' : 's'}`)
      setWatching(true)
    },
    onError: (err) => toast.error(err.message),
    onSettled: () => setAsking(false),
  })
  const auto = useMutation({
    mutationFn: (enabled) => api('/images/auto-cleanup', { method: 'POST', body: { enabled } }),
    onSuccess: (r) => {
      toast.success(r.enabled ? 'Automatic clean-up is on for every app' : 'Automatic clean-up is off for every app')
      client.invalidateQueries({ queryKey: ['old-images'] })
      client.invalidateQueries({ queryKey: ['apps'] })
      client.invalidateQueries({ queryKey: ['app'] })
      client.invalidateQueries({ queryKey: ['images'] })
    },
    onError: (err) => toast.error(err.message),
  })

  const d = old.data
  const withOld = d?.apps.filter((a) => a.reclaimableBytes > 0) ?? []
  const allOn = d && d.autoCleanup.on === d.autoCleanup.total // (with no apps the button is not shown)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Old images</CardTitle>
        <CardDescription>
          Every deployment leaves an image behind. Each app keeps its live version and the earlier versions you chose (so you can roll back); the rest are old and
          can be removed. Cleaning removes images only: no logs, volumes, containers or build cache.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {old.isError && <LoadError error={old.error} title="Could not load the old images" onRetry={() => old.refetch()} />}
        {d && (
          <>
            {d.reclaimableBytes === 0 ? (
              <p className="text-sm">No old images.</p>
            ) : (
              <div className="space-y-1 text-sm">
                <p className={d.exceeded ? 'font-medium text-warning' : undefined}>
                  About {formatBytes(d.reclaimableBytes)} could be freed in {withOld.length} app{withOld.length === 1 ? '' : 's'}.{' '}
                  <span className="font-normal text-muted-foreground">An upper bound: versions of one app share files, so less is usually freed.</span>
                </p>
                <ul className="text-muted-foreground">
                  {withOld.map((a) => (
                    <li key={a.appId}><Link to={`/apps/${a.appId}/images`} className="hover:underline">{a.name}</Link>: {a.images} old image{a.images === 1 ? '' : 's'}, up to {formatBytes(a.reclaimableBytes)}</li>
                  ))}
                </ul>
              </div>
            )}
            {watching && <p role="status" className="text-sm text-muted-foreground">Cleaning… the figures update as each app finishes.</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={clean.isPending || d.apps.length === 0} onClick={() => setAsking(true)}>Clean up old images</Button>
            </div>

            <div className="space-y-2 border-t pt-4">
              <p className="text-sm">
                Automatic clean-up after every successful deployment is on for {d.autoCleanup.on} of {d.autoCleanup.total} app{d.autoCleanup.total === 1 ? '' : 's'}. New apps start with it on.
              </p>
              {d.autoCleanup.total > 0 && (
                <Button variant="outline" size="sm" disabled={auto.isPending} onClick={() => auto.mutate(!allOn)}>
                  {allOn ? 'Turn off for every app' : 'Turn on for every app'}
                </Button>
              )}
            </div>

            <div className="border-t pt-4">
              <Threshold current={d.thresholdBytes} />
            </div>
          </>
        )}
      </CardContent>
      <AlertDialog open={asking} onOpenChange={(open) => !open && setAsking(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean up the old images of every app?</AlertDialogTitle>
            <AlertDialogDescription>
              Each app keeps its live version and the earlier versions it is set to keep. The images of older versions are removed, and those versions can no longer be rolled
              back to (their history and logs stay). Nothing that is running is touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); clean.mutate() }}>Clean up</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
