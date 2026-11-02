import { useState } from 'react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { useAppVolumes, useApps } from '@/lib/queries'
import { codeFolderWarning, normalizeVolumePath } from '@/lib/volumes'
import { AppChoice, receivingApps } from '@/components/app-choice'
import { Field } from '@/components/field'

/** Attaches a kept volume (its data as it is, nothing copied) to an app at a path; the app mounts it from its next deployment. */
export function ReclaimVolumeDialog({ volume, onClose }) {
  const client = useQueryClient()
  const apps = useApps()
  const [appId, setAppId] = useState('')
  const [path, setPath] = useState(volume.path)
  const [problem, setProblem] = useState(null)
  const theirs = useAppVolumes(appId || undefined)
  const chosen = receivingApps(apps.data).find((a) => a.id === appId)
  const tidy = normalizeVolumePath(path)
  const already = tidy.path && (theirs.data?.volumes ?? []).some((v) => v.state === 'in_use' && v.path === tidy.path)
  const warning = tidy.path ? codeFolderWarning(tidy.path) : null
  const reclaim = useMutation({
    mutationFn: () => api(`/volumes/${volume.id}/reclaim`, { method: 'POST', body: { appId, path: tidy.path } }),
    onSuccess: () => {
      toast.success(`${tidy.path} is attached to ${chosen?.name}. Deploy ${chosen?.name} to mount it.`)
      for (const key of [['kept-volumes'], ['volumes'], ['apps'], ['storage']]) client.invalidateQueries({ queryKey: key })
      onClose()
    },
    onError: (err) => setProblem(err.message),
  })
  const blocked = !appId || !tidy.path || already
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => { e.preventDefault(); setProblem(null); if (!blocked) reclaim.mutate() }} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>Reclaim this volume</DialogTitle>
            <DialogDescription>
              Attach the data that was kept at <span className="font-mono">{volume.path}</span> to an app. Nothing is copied: the files stay exactly as they are. The app mounts the volume from its <strong>next deployment</strong>.
            </DialogDescription>
          </DialogHeader>
          <AppChoice id="reclaim-volume-app" label="Attach it to" value={appId} onChange={(v) => { setAppId(v); setProblem(null) }} />
          <Field id="reclaim-volume-path" label="Mount it at (the folder inside the app)" error={tidy.error && path.trim() !== '' ? tidy.error : already ? `${chosen?.name} already keeps ${tidy.path}. Choose another path.` : problem}
            hint="For example /data. The path must not be inside another persistent path of that app, or contain one.">
            <Input id="reclaim-volume-path" className="font-mono" value={path} aria-invalid={tidy.error || already ? true : undefined} onChange={(e) => { setPath(e.target.value); setProblem(null) }} />
          </Field>
          {warning && <Alert className="border-warning/50 text-warning" role="status" aria-label="Code folder"><AlertDescription>{warning}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={blocked || reclaim.isPending}>{reclaim.isPending ? 'Attaching…' : 'Reclaim'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
