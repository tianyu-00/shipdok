import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { useRepos } from '@/lib/queries'
import { Field } from '@/components/field'

const num = (v) => (v === '' ? undefined : Number(v))

export default function CreateAppPage() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const repos = useRepos()
  const [f, setF] = useState({
    repo: '', name: '', branch: 'main', root_dir: '.', container_port: '3000', host_port: '', health_path: '',
    memory_mb: '512', cpus: '1', max_restarts: '5', keep_previous_images: '1', auto_prune: false,
  })
  const [nameTouched, setNameTouched] = useState(false)
  const set = (patch) => setF((old) => ({ ...old, ...patch }))

  // Picking (or typing) a repository from the GitHub App's list fills in a name and the repository's own default branch.
  const onRepo = (repo) => {
    const known = repos.data?.repos.find((r) => r.fullName === repo)
    set({
      repo,
      ...(nameTouched ? {} : { name: repo.split('/')[1] ?? '' }),
      ...(known?.defaultBranch ? { branch: known.defaultBranch } : {}),
    })
  }

  const create = useMutation({
    mutationFn: () => api('/apps', {
      method: 'POST',
      body: {
        name: f.name.trim(), repo: f.repo.trim(), branch: f.branch.trim() || undefined, root_dir: f.root_dir.trim() || undefined,
        container_port: num(f.container_port), host_port: num(f.host_port),
        ...(f.health_path.trim() ? { health_path: f.health_path.trim() } : {}),
        memory_mb: num(f.memory_mb), cpus: num(f.cpus), max_restarts: num(f.max_restarts),
        keep_previous_images: num(f.keep_previous_images), auto_prune: f.auto_prune,
      },
    }),
    onSuccess: (app) => {
      client.invalidateQueries({ queryKey: ['apps'] })
      toast.success(`${app.name} created`)
      if (app.warning) toast.warning(app.warning, { duration: 12_000 })
      navigate(`/apps/${app.id}`)
    },
  })

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />All apps</Link>
      <Card>
        <CardHeader>
          <CardTitle>New app</CardTitle>
          <CardDescription>Shipdok clones the repository, builds its Dockerfile and runs it in a container.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); create.mutate() }} noValidate>
            <Field id="repo" label="GitHub repository" hint={repos.data?.available ? 'Repositories the Shipdok GitHub App can see. You can also type owner/repo.' : 'owner/repo. Private repositories need the Shipdok GitHub App.'}>
              <Input id="repo" list="repo-list" placeholder="owner/repo" autoComplete="off" value={f.repo} onChange={(e) => onRepo(e.target.value)} />
              <datalist id="repo-list">
                {repos.data?.repos.map((r) => <option key={r.fullName} value={r.fullName}>{r.private ? 'private' : 'public'}</option>)}
              </datalist>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="name" label="Name"><Input id="name" value={f.name} onChange={(e) => { setNameTouched(true); set({ name: e.target.value }) }} /></Field>
              <Field id="branch" label="Branch"><Input id="branch" value={f.branch} onChange={(e) => set({ branch: e.target.value })} /></Field>
              <Field id="container_port" label="Container port" hint="The port the app listens on inside its container.">
                <Input id="container_port" inputMode="numeric" value={f.container_port} onChange={(e) => set({ container_port: e.target.value })} />
              </Field>
              <Field id="host_port" label="Host port" hint="The port it is published on, 1024 or higher. Each app needs its own. Leave empty to pick a free one automatically.">
                <Input id="host_port" inputMode="numeric" placeholder="automatic" value={f.host_port} onChange={(e) => set({ host_port: e.target.value })} />
              </Field>
              <Field id="health_path" label="Health check path" hint="Optional, for example /health. Without it, any answer counts as healthy.">
                <Input id="health_path" placeholder="/health" value={f.health_path} onChange={(e) => set({ health_path: e.target.value })} />
              </Field>
              <Field id="root_dir" label="Root directory" hint="Where the Dockerfile is, inside the repository.">
                <Input id="root_dir" value={f.root_dir} onChange={(e) => set({ root_dir: e.target.value })} />
              </Field>
            </div>

            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">Limits and clean-up</summary>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field id="memory_mb" label="Memory limit (MB)"><Input id="memory_mb" inputMode="numeric" value={f.memory_mb} onChange={(e) => set({ memory_mb: e.target.value })} /></Field>
                <Field id="cpus" label="CPU limit"><Input id="cpus" inputMode="decimal" value={f.cpus} onChange={(e) => set({ cpus: e.target.value })} /></Field>
                <Field id="max_restarts" label="Automatic restarts" hint="Crashes allowed within 10 minutes before the app is marked crashed. 0 = never restart by itself.">
                  <Input id="max_restarts" inputMode="numeric" value={f.max_restarts} onChange={(e) => set({ max_restarts: e.target.value })} />
                </Field>
                <Field id="keep_previous_images" label="Earlier versions kept" hint="Images of earlier versions kept besides the running one, so you can roll back.">
                  <Input id="keep_previous_images" inputMode="numeric" value={f.keep_previous_images} onChange={(e) => set({ keep_previous_images: e.target.value })} />
                </Field>
                <div className="flex items-center gap-3 sm:col-span-2">
                  <Switch id="auto_prune" checked={f.auto_prune} onCheckedChange={(v) => set({ auto_prune: v })} />
                  <Label htmlFor="auto_prune">Remove old images automatically after each deployment</Label>
                </div>
              </div>
            </details>

            {create.isError && (
              <div role="alert" className="space-y-1 text-sm text-destructive">
                <p>{create.error.message}</p>
                {create.error.body?.details?.length > 0 && <ul className="list-disc pl-5">{create.error.body.details.map((d) => <li key={d}>{d}</li>)}</ul>}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" asChild><Link to="/">Cancel</Link></Button>
              <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create app'}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
