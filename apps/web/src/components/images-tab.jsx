import { useState } from 'react'
import { Eraser } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { useImages } from '@/lib/queries'
import { formatBytes, shortSha, timeAgo } from '@/lib/format'
import { prunableVersions } from '@/lib/versions'
import { ListSkeleton, LoadError } from '@/components/states'
import { VersionBadge } from '@/components/version-badge'

function Retention({ app, images }) {
  const client = useQueryClient()
  const [keep, setKeep] = useState(String(images.keep_previous_images))
  const n = Number(keep)
  const valid = keep.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 10
  const save = useMutation({
    mutationFn: (body) => api(`/apps/${app.id}/retention`, { method: 'PUT', body }),
    onSuccess: () => { toast.success('Saved'); for (const key of [['images', app.id], ['app', app.id], ['apps']]) client.invalidateQueries({ queryKey: key }) },
    onError: (err) => toast.error(err.message),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Keeping old versions</CardTitle>
        <CardDescription>The running version's image is always kept. Earlier ones are kept so you can roll back to them; clean-up removes the rest.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (valid && !save.isPending) save.mutate({ keep_previous_images: n }) }}>
          <div className="space-y-1.5">
            <Label htmlFor="keep">Earlier versions to keep (0 to 10)</Label>
            <Input id="keep" type="number" inputMode="numeric" min={0} max={10} className="w-28" value={keep} onChange={(e) => setKeep(e.target.value)} aria-invalid={!valid} />
          </div>
          <Button type="submit" variant="outline" disabled={!valid || save.isPending || n === images.keep_previous_images}>Save</Button>
          {!valid && <p className="text-sm text-destructive">Enter a whole number from 0 to 10.</p>}
        </form>
        <div className="flex items-center gap-3">
          <Switch id="auto-prune" checked={images.auto_prune} disabled={save.isPending} onCheckedChange={(on) => save.mutate({ auto_prune: on })} />
          <Label htmlFor="auto-prune" className="font-normal">Clean up automatically after every successful deployment</Label>
        </div>
        <p className="text-sm text-muted-foreground">Logs are never removed by a clean-up. Delete them yourself when you want them gone.</p>
      </CardContent>
    </Card>
  )
}

function CleanupSummary({ cleanup, running }) {
  if (running) return <p className="text-sm text-info">Clean-up is running…</p>
  if (!cleanup) return <p className="text-sm text-muted-foreground">No clean-up has run yet.</p>
  return (
    <div className="space-y-1 text-sm">
      <p>
        Last clean-up {timeAgo(cleanup.last_run_at)} ({cleanup.trigger === 'auto' ? 'automatic' : 'on request'}): removed {cleanup.images_removed} image{cleanup.images_removed === 1 ? '' : 's'},
        freed {formatBytes(cleanup.freed_bytes)}.
        {cleanup.skipped > 0 && ` ${cleanup.skipped} skipped because something still uses ${cleanup.skipped === 1 ? 'it' : 'them'}.`}
      </p>
      {cleanup.error && <p className="text-destructive">It reported a problem: {cleanup.error}</p>}
    </div>
  )
}

export default function ImagesTab({ app }) {
  const client = useQueryClient()
  const imagesQuery = useImages(app.id)
  const [asking, setAsking] = useState(false)
  const [waitingSince, setWaitingSince] = useState(undefined) // the last_run_at we saw when the clean-up was queued (null = none yet)

  const prune = useMutation({
    mutationFn: () => api(`/apps/${app.id}/prune`, { method: 'POST' }),
    onSuccess: () => {
      setWaitingSince(imagesQuery.data?.cleanup?.last_run_at ?? null)
      setAsking(false)
      toast.success('Clean-up queued')
      client.invalidateQueries({ queryKey: ['images', app.id] })
    },
    onError: (err) => { setAsking(false); toast.error(err.message) },
  })

  if (imagesQuery.isPending) return <ListSkeleton rows={2} />
  if (imagesQuery.isError) return <LoadError error={imagesQuery.error} onRetry={() => imagesQuery.refetch()} title="Could not load the images" />
  const images = imagesQuery.data
  const doomed = prunableVersions(images)
  const running = waitingSince !== undefined && (images.cleanup?.last_run_at ?? null) === waitingSince

  return (
    <div className="space-y-6">
      <Retention key={`${images.keep_previous_images}`} app={app} images={images} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Clean up</CardTitle>
          <CardDescription>
            Removes saved images that are no longer kept{doomed.length > 0 ? ` (up to ${formatBytes(images.prunableBytes)}; versions of one app share files, so less is usually freed)` : ''}.
            Their deployments and logs stay; they just cannot be rolled back to.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CleanupSummary cleanup={images.cleanup} running={running} />
          <Button variant="outline" disabled={running || prune.isPending} onClick={() => setAsking(true)}><Eraser className="size-4" />Clean up now</Button>
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow><TableHead>Version</TableHead><TableHead>Commit</TableHead><TableHead>Deployed</TableHead><TableHead>Image size</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {images.versions.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-muted-foreground">No successful deployments yet.</TableCell></TableRow>
            )}
            {images.versions.map((v) => (
              <TableRow key={v.deploymentId}>
                <TableCell><VersionBadge state={v.state} /></TableCell>
                <TableCell className="font-mono text-xs">{shortSha(v.commit)}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{timeAgo(v.finishedAt)}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{v.state === 'removed' ? '—' : formatBytes(v.bytes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clean up {app.name}?</DialogTitle>
            <DialogDescription>These saved images will be removed. This cannot be undone: those versions cannot be rolled back to afterwards.</DialogDescription>
          </DialogHeader>
          {doomed.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {doomed.map((v) => (
                <li key={v.image} className="flex items-center justify-between gap-3 rounded-md border px-3 py-1.5">
                  <span><span className="font-mono text-xs">{shortSha(v.commit)}</span> <span className="text-muted-foreground">from {timeAgo(v.finishedAt)}</span></span>
                  <span className="text-muted-foreground">{formatBytes(v.bytes)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Alert>
              <AlertTitle>No old versions to remove</AlertTitle>
              <AlertDescription>Only leftovers of failed or cancelled builds, if there are any, would be removed.</AlertDescription>
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">The running version, the {images.keep_previous_images} earlier version{images.keep_previous_images === 1 ? '' : 's'} you keep, and all logs stay.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(false)}>Cancel</Button>
            <Button disabled={prune.isPending} onClick={() => prune.mutate()}>Clean up</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
