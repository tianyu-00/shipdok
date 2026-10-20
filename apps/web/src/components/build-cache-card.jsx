import { useState } from 'react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api, ApiError } from '@/lib/api'
import { useBuildCache } from '@/lib/queries'
import { formatBytes, timeAgo } from '@/lib/format'
import { LoadError } from '@/components/states'

const CHOICES = {
  unused: {
    all: false,
    title: 'Clean the unused build cache?',
    text: 'Removes build cache that no build has used for the last 24 hours. Recent builds keep their cache, so the apps you deploy often stay fast.',
  },
  everything: {
    all: true,
    title: 'Clean all the unused build cache?',
    text: 'Removes every part of the build cache that is not in use right now. The next build of each app starts from nothing: it runs every step again and downloads packages again, which is slow (on a Raspberry Pi, often several minutes).',
  },
}

/**
 * Docker's build cache. Every build leaves steps behind so the next build is faster; all apps share it, so it belongs to no app and the image
 * clean-up never removes it. The worker measures it and cleans it; this card shows the last figures and asks for a clean-up.
 */
export default function BuildCacheCard() {
  const cache = useBuildCache()
  const client = useQueryClient()
  const [asking, setAsking] = useState(null) // 'unused' | 'everything' while the question is open
  const clean = useMutation({
    mutationFn: (all) => api('/build-cache/clean', { method: 'POST', body: { all } }),
    onSuccess: () => { toast.success('Cleaning the build cache…'); client.invalidateQueries({ queryKey: ['build-cache'] }) },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) client.invalidateQueries({ queryKey: ['build-cache'] })
      toast.error(err.message)
    },
    onSettled: () => setAsking(null),
  })
  const d = cache.data
  const busy = clean.isPending || d?.cleaning === true

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Build cache</CardTitle>
        <CardDescription>
          Docker keeps the steps of every build so the next build is faster. All apps share this cache, so it grows with every build and the
          image clean-up does not remove it. Cleaning touches nothing else: no images, containers, volumes or logs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {cache.isError && <LoadError error={cache.error} title="Could not load the build cache" onRetry={() => cache.refetch()} />}
        {d && (
          <>
            {d.totalBytes === null ? (
              <p className="text-sm text-muted-foreground">Not measured yet. The worker measures it every few minutes.</p>
            ) : (
              <p className="text-sm">
                {formatBytes(d.totalBytes)} in the cache, {formatBytes(d.reclaimableBytes)} of it not in use.{' '}
                <span className="text-muted-foreground">Measured {timeAgo(d.sampledAt)}.</span>
              </p>
            )}
            {d.cleaning && <p role="status" className="text-sm text-muted-foreground">Cleaning… this waits for any build in progress.</p>}
            {!d.cleaning && d.last && (d.last.error ? (
              <p role="status" className="text-sm text-destructive">The last clean-up ({timeAgo(d.last.at)}) failed: {d.last.error}</p>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Last clean-up {timeAgo(d.last.at)} ({d.last.all ? 'everything unused' : 'unused for a day'}): {formatBytes(d.last.freedBytes)} freed.
              </p>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setAsking('unused')}>Clean unused cache</Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setAsking('everything')}>Clean everything unused</Button>
            </div>
          </>
        )}
      </CardContent>
      <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{asking && CHOICES[asking].title}</AlertDialogTitle>
            <AlertDialogDescription>{asking && CHOICES[asking].text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); clean.mutate(CHOICES[asking].all) }}>Clean</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
