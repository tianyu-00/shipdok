import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { useAppVolumes } from '@/lib/queries'
import { codeFolderWarning, normalizeVolumePath, volumePathsProblem } from '@/lib/volumes'
import { formatBytes, timeAgo } from '@/lib/format'
import { MeasureSizes } from '@/components/measure-sizes'

/** The container paths an app keeps (Docker volumes that outlive every deployment). Saving only changes the NEXT deployment. */
export default function VolumesCard({ app }) {
  const client = useQueryClient()
  const volumes = useAppVolumes(app.id)
  const all = volumes.data?.volumes ?? []
  const mounted = all.filter((v) => v.state === 'in_use')
  const detached = all.filter((v) => v.state === 'detached')
  const [edited, setEdited] = useState(null) // null: nothing changed yet, so show what the server has
  const [typed, setTyped] = useState('')
  const [problem, setProblem] = useState(null)

  const serverPaths = mounted.map((v) => v.path).sort()
  const paths = edited ?? serverPaths
  const dirty = edited !== null && JSON.stringify(edited) !== JSON.stringify(serverPaths)
  const dockerName = (path) => mounted.find((v) => v.path === path)?.dockerName
  const sizeOf = (path) => mounted.find((v) => v.path === path)

  const add = () => {
    const one = normalizeVolumePath(typed)
    const next = one.path ? [...paths, one.path].sort() : null
    const bad = one.error ?? volumePathsProblem(next)
    if (bad) { setProblem(bad); return }
    setProblem(null); setTyped(''); setEdited(next)
  }

  const save = useMutation({
    mutationFn: () => api(`/apps/${app.id}/volumes`, { method: 'PUT', body: { paths } }),
    onSuccess: () => {
      toast.success('Saved. Deploy to apply the changes.')
      setEdited(null)
      client.invalidateQueries({ queryKey: ['volumes', app.id] })
      client.invalidateQueries({ queryKey: ['app', app.id] })
    },
    onError: (err) => toast.error(err.message),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Persistent storage</CardTitle>
        <CardDescription className="space-y-1">
          <span className="block">Files written to these folders survive redeploys, rollbacks and restarts. Each path becomes a Docker volume owned by this app.</span>
          <span className="block">A path you remove here is not deleted: its data is kept (see Storage), and adding the path again brings it back.</span>
          <span className="block">If your app runs as a non-root user, create the folder in your Dockerfile and give that user ownership of it, or the app cannot write there.</span>
          <span className="block font-medium text-warning">Do not use the folder your app's code is in (often /app or /usr/src/app). The volume would keep an old copy of the code and hide every new version, so new pushes would keep running old code. Use a data folder, such as /data or /app/data.</span>
          <span className="block">Applies from the next deployment.</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {paths.length > 0 && (
          <ul className="divide-y rounded-md border">
            {paths.map((p) => (
              <li key={p} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm">{p}</p>
                  {dockerName(p) && <p className="truncate font-mono text-xs text-muted-foreground">{dockerName(p)}</p>}
                  {sizeOf(p) && (
                    <p className="text-xs text-muted-foreground">
                      {sizeOf(p).sizeBytes === null
                        ? (sizeOf(p).measuredAt ? 'Not created in Docker yet (the first deployment creates it)' : 'Size not measured yet')
                        : `${formatBytes(sizeOf(p).sizeBytes)}, measured ${timeAgo(sizeOf(p).measuredAt)}`}
                    </p>
                  )}
                  {codeFolderWarning(p) && <p role="status" className="mt-1 text-xs text-warning">{codeFolderWarning(p)}</p>}
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${p}`} onClick={() => setEdited(paths.filter((x) => x !== p))}><X className="size-4" /></Button>
              </li>
            ))}
          </ul>
        )}
        {mounted.length + detached.length > 0 && <MeasureSizes />}
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); add() }}>
          <Label htmlFor="volume-path">Add a path</Label>
          <div className="flex gap-2">
            <Input id="volume-path" placeholder="/app/uploads" autoComplete="off" value={typed} onChange={(e) => { setTyped(e.target.value); setProblem(null) }} aria-invalid={problem ? true : undefined} />
            <Button type="submit" variant="outline"><Plus className="size-4" />Add path</Button>
          </div>
          {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
          {!problem && codeFolderWarning(typed) && <p role="status" className="text-sm text-warning">{codeFolderWarning(typed)}</p>}
        </form>
        {detached.length > 0 && (
          <section aria-label="Kept but not mounted" className="rounded-md border border-dashed p-3 text-sm">
            <p className="font-medium">Kept but not mounted</p>
            <ul className="mt-1 space-y-1">
              {detached.map((v) => <li key={v.id} className="font-mono text-xs text-muted-foreground">{v.path}</li>)}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">Their data is safe. Adding the same path again brings it back; delete one for good on the Storage page.</p>
          </section>
        )}
        <div className="flex justify-end">
          <Button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save storage'}</Button>
        </div>
      </CardContent>
    </Card>
  )
}
