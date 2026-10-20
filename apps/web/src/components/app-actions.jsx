import { useState } from 'react'
import { ChevronDown, Play, RefreshCw, Rocket, Square } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api, ApiError } from '@/lib/api'

// Anything the buttons change is re-read straight away instead of waiting for the next poll.
function useRefresh(appId) {
  const client = useQueryClient()
  return () => Promise.all([
    client.invalidateQueries({ queryKey: ['app', appId] }),
    client.invalidateQueries({ queryKey: ['apps'] }),
    client.invalidateQueries({ queryKey: ['deployments', appId] }),
  ])
}

/**
 * Deploy. A stopped app stays stopped unless the administrator says otherwise, so for a stopped app the button offers both.
 * When the disk is almost full the API refuses first; the administrator then chooses to continue or stop.
 * "Deploy without cache" (in the menu next to Deploy) builds every step again for this one deployment.
 */
export function DeployButton({ app }) {
  const refresh = useRefresh(app.id)
  const [diskAsk, setDiskAsk] = useState(null) // { disk, start, noCache } while the "almost full" question is open
  const [noCacheAsk, setNoCacheAsk] = useState(false)
  const stopped = app.desired_state === 'stopped'

  const deploy = useMutation({
    mutationFn: ({ start, ignoreDiskWarning, noCache }) => api(`/apps/${app.id}/deployments`, {
      method: 'POST',
      body: { ...(start ? { start: true } : {}), ...(ignoreDiskWarning ? { ignoreDiskWarning: true } : {}), ...(noCache ? { noCache: true } : {}) },
    }),
    onSuccess: (d) => {
      toast.success('Deployment queued')
      if (d.warning) toast.warning(d.warning)
      refresh()
    },
    onError: (err, vars) => {
      if (err instanceof ApiError && err.status === 409 && err.body?.code === 'disk_critical') {
        setDiskAsk({ disk: err.body.disk, start: vars.start, noCache: vars.noCache })
        return
      }
      toast.error(err.message)
    },
  })

  return (
    <>
      <div className="inline-flex">
        <Button className="rounded-r-none" onClick={() => deploy.mutate({ start: false })} disabled={deploy.isPending}>
          <Rocket className="size-4" />Deploy
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="rounded-l-none border-l border-primary-foreground/30 px-2" aria-label="More ways to deploy" disabled={deploy.isPending}>
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => setNoCacheAsk(true)}>Deploy without cache…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {stopped && (
        <Button variant="outline" onClick={() => deploy.mutate({ start: true })} disabled={deploy.isPending}>
          Deploy and start
        </Button>
      )}
      <AlertDialog open={noCacheAsk} onOpenChange={setNoCacheAsk}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deploy without the build cache?</AlertDialogTitle>
            <AlertDialogDescription>
              Every step of the build runs again instead of being reused, so this deployment takes longer (on a Raspberry Pi, often several minutes) and
              downloads packages again. Use it when a build keeps an old result it should not. Base images already on this machine are not re-downloaded.
              Only this deployment is affected: the next push uses the cache again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deploy.mutate({ start: false, noCache: true })}>Deploy without cache</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={diskAsk !== null} onOpenChange={(open) => !open && setDiskAsk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>The disk is almost full</AlertDialogTitle>
            <AlertDialogDescription>
              Only {diskAsk?.disk?.freePercent}% is free. A build may fail or fill the disk completely. You can free space first
              (prune old images, delete old logs) or deploy anyway.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stop</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const ask = diskAsk; setDiskAsk(null); deploy.mutate({ start: ask.start, ignoreDiskWarning: true, noCache: ask.noCache }) }}>
              Deploy anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

const CONTROLS = {
  start: { label: 'Start', Icon: Play, done: 'Start requested' },
  stop: { label: 'Stop', Icon: Square, done: 'Stop requested' },
  restart: { label: 'Restart', Icon: RefreshCw, done: 'Restart requested' },
}

/** Start, stop and restart. The API records the wish at once and the worker carries it out, so the page then follows along. */
export function ControlButtons({ app }) {
  const refresh = useRefresh(app.id)
  const [confirmStop, setConfirmStop] = useState(false)
  const act = useMutation({
    mutationFn: (action) => api(`/apps/${app.id}/${action}`, { method: 'POST' }),
    onSuccess: (_, action) => { toast.success(CONTROLS[action].done); refresh() },
    onError: (err) => toast.error(err.message),
  })
  const stopped = app.desired_state === 'stopped'
  const state = app.runtime?.state
  // A missing container has nothing to start, stop or restart: Deploy is the way back.
  const buttons = state === 'missing' ? [] : stopped ? ['start'] : state === 'crashed' ? ['start', 'restart'] : ['restart', 'stop']
  return (
    <>
      {buttons.map((action) => {
        const { label, Icon } = CONTROLS[action]
        return (
          <Button key={action} variant="outline" disabled={act.isPending} onClick={() => (action === 'stop' ? setConfirmStop(true) : act.mutate(action))}>
            <Icon className="size-4" />{label}
          </Button>
        )
      })}
      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {app.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The container is stopped but kept. New pushes will not deploy while it is stopped, and later deployments leave it stopped
              until you start it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => act.mutate('stop')}>Stop</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
