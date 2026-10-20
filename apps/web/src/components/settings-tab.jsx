import { useState } from 'react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api, ApiError } from '@/lib/api'
import { settingsChanges, settingsProblems, settingsToForm } from '@/lib/settings'
import { Field } from '@/components/field'
import { PendingSettings } from '@/components/pending-settings'
import { RepoLink } from '@/components/repo-link'
import { DeleteApp } from '@/components/delete-app'
import VolumesCard from '@/components/volumes-card'

// Which field a refusal from the server belongs to.
const SERVER_FIELD = { port_taken: 'host_port', name_taken: 'name' }

function SettingsForm({ app }) {
  const client = useQueryClient()
  const [f, setF] = useState(() => settingsToForm(app))
  const [shown, setShown] = useState({}) // field -> message, from the checks or from the server
  const set = (k) => (e) => { setF((old) => ({ ...old, [k]: e.target.value })); setShown((old) => ({ ...old, [k]: undefined })) }
  const changes = settingsChanges(f, app)
  const dirty = Object.keys(changes).length > 0

  const save = useMutation({
    mutationFn: (body) => api(`/apps/${app.id}`, { method: 'PUT', body }),
    onSuccess: (updated) => {
      client.setQueryData(['app', app.id], updated)
      client.invalidateQueries({ queryKey: ['apps'] })
      toast.success((updated.settings_pending ?? []).length ? 'Saved. Deploy to apply the changes.' : 'Saved')
    },
    onError: (err) => {
      const field = err instanceof ApiError ? SERVER_FIELD[err.body?.code] : undefined
      if (field) setShown((old) => ({ ...old, [field]: err.message }))
      else toast.error(err.message)
    },
  })

  const submit = (e) => {
    e.preventDefault()
    const problems = settingsProblems(f)
    setShown(problems)
    if (Object.keys(problems).length === 0 && dirty && !save.isPending) save.mutate(changes)
  }
  const err = (k) => shown[k]
  const bad = (k) => (shown[k] ? true : undefined)
  const details = save.error instanceof ApiError && !SERVER_FIELD[save.error.body?.code] ? save.error.body?.details : null

  return (
    <form className="space-y-5" onSubmit={submit} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="s-name" label="Name" error={err('name')}><Input id="s-name" aria-invalid={bad('name')} value={f.name} onChange={set('name')} /></Field>
        <Field id="s-branch" label="Branch" error={err('branch')} hint="Pushes to this branch deploy the app."><Input id="s-branch" aria-invalid={bad('branch')} value={f.branch} onChange={set('branch')} /></Field>
        <Field id="s-container_port" label="Container port" error={err('container_port')} hint="The port the app listens on inside its container.">
          <Input id="s-container_port" inputMode="numeric" aria-invalid={bad('container_port')} value={f.container_port} onChange={set('container_port')} />
        </Field>
        <Field id="s-host_port" label="Host port" error={err('host_port')}
          hint="The port it is published on. A change takes effect with the next deployment, and the old port stops answering then. Shipdok checks its own apps only: if something else on this machine uses the port, that deployment fails and the running version is restored.">
          <Input id="s-host_port" inputMode="numeric" aria-invalid={bad('host_port')} value={f.host_port} onChange={set('host_port')} />
        </Field>
        <Field id="s-health_path" label="Health check path" error={err('health_path')} hint="Leave empty for no health check: any answer counts as healthy.">
          <Input id="s-health_path" placeholder="/health" aria-invalid={bad('health_path')} value={f.health_path} onChange={set('health_path')} />
        </Field>
        <Field id="s-root_dir" label="Root directory" error={err('root_dir')} hint="Where the Dockerfile is, inside the repository.">
          <Input id="s-root_dir" aria-invalid={bad('root_dir')} value={f.root_dir} onChange={set('root_dir')} />
        </Field>
        <Field id="s-memory_mb" label="Memory limit (MB)" error={err('memory_mb')}><Input id="s-memory_mb" inputMode="numeric" aria-invalid={bad('memory_mb')} value={f.memory_mb} onChange={set('memory_mb')} /></Field>
        <Field id="s-cpus" label="CPU limit" error={err('cpus')}><Input id="s-cpus" inputMode="decimal" aria-invalid={bad('cpus')} value={f.cpus} onChange={set('cpus')} /></Field>
        <Field id="s-build_timeout_minutes" label="Build time limit (minutes)" error={err('build_timeout_minutes')}
          hint="Leave empty for no limit. Otherwise a clone and build that take longer than this are stopped and the deployment fails; the running version is untouched. With no limit, a build that hangs blocks other deployments until you cancel it. It applies from the next deployment.">
          <Input id="s-build_timeout_minutes" inputMode="numeric" placeholder="no limit" aria-invalid={bad('build_timeout_minutes')} value={f.build_timeout_minutes} onChange={set('build_timeout_minutes')} />
        </Field>
        <Field id="s-max_restarts" label="Automatic restarts" error={err('max_restarts')} hint="Crashes allowed within 10 minutes before the app is marked crashed. 0 = never restart by itself. Applies at once.">
          <Input id="s-max_restarts" inputMode="numeric" aria-invalid={bad('max_restarts')} value={f.max_restarts} onChange={set('max_restarts')} />
        </Field>
      </div>
      {details?.length > 0 && <ul role="alert" className="list-disc pl-5 text-sm text-destructive">{details.map((d) => <li key={d}>{d}</li>)}</ul>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={!dirty || save.isPending} onClick={() => { setF(settingsToForm(app)); setShown({}); save.reset() }}>Discard changes</Button>
        <Button type="submit" disabled={!dirty || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  )
}

export default function SettingsTab({ app }) {
  return (
    <div className="space-y-4">
      <PendingSettings app={app} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Settings</CardTitle>
          <CardDescription>
            Repository: <RepoLink repo={app.repo} />. It cannot be changed: to use a different repository, delete this app and create a new one.
            Changes reach the running app with the next deployment, except the name and the restart limit.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* A new form (fresh values) whenever the server's copy changes, for example after saving. */}
          <SettingsForm key={app.updated_at} app={app} />
        </CardContent>
      </Card>
      <VolumesCard app={app} />
      <DeleteApp app={app} />
    </div>
  )
}
