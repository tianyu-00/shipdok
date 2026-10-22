import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { BranchPicker } from '@/components/branch-picker'
import { BuildMethodFields } from '@/components/build-method-fields'
import { Field } from '@/components/field'
import { cardFor } from '@/lib/build-methods'

/** Step 3: the rest of the app's settings. The repository, the folder and the build method were chosen before, and can be changed from here. */
export function DetailsStep({ f, set, setNameTouched, branchTouched, setBranchTouched, githubApp, mutation, canCreate, onChangeRepo, onChangeMethod, onBack, onSubmit }) {
  return (
    <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); onSubmit() }} noValidate>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Repository</dt>
        <dd><strong>{f.repo}</strong> <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onChangeRepo}>Change</Button></dd>
        <dt className="text-muted-foreground">Folder</dt>
        <dd>{f.root_dir.trim() || '.'}</dd>
        <dt className="text-muted-foreground">Built with</dt>
        <dd>{cardFor(f.build_method)?.title ?? f.build_method} <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onChangeMethod}>Change</Button></dd>
      </dl>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="name" label="Name"><Input id="name" value={f.name} onChange={(e) => { setNameTouched(true); set({ name: e.target.value }) }} /></Field>
        <Field id="branch" label="Branch" hint="Pushes to this branch deploy the app.">
          <BranchPicker id="branch" repo={f.repo} value={f.branch} githubAppId={githubApp || undefined}
            onChange={(branch) => { setBranchTouched(true); set({ branch }) }}
            onDefaultKnown={(branch) => { if (!branchTouched) set({ branch }) }} />
        </Field>
        <Field id="container_port" label="Container port" hint="The port the app listens on inside its container.">
          <Input id="container_port" inputMode="numeric" value={f.container_port} onChange={(e) => set({ container_port: e.target.value })} />
        </Field>
        <Field id="host_port" label="Host port" hint="The port it is published on, 1024 or higher. Each app needs its own. Leave empty to pick a free one automatically.">
          <Input id="host_port" inputMode="numeric" placeholder="automatic" value={f.host_port} onChange={(e) => set({ host_port: e.target.value })} />
        </Field>
        <Field id="health_path" label="Health check path" hint="Optional, for example /health. Without it, any answer counts as healthy.">
          <Input id="health_path" placeholder="/health" value={f.health_path} onChange={(e) => set({ health_path: e.target.value })} />
        </Field>
        <BuildMethodFields values={f} onChange={(k, v) => set({ [k]: v })} selectable={false} />
      </div>

      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">Limits and clean-up</summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field id="memory_mb" label="Memory limit (MB)"><Input id="memory_mb" inputMode="numeric" value={f.memory_mb} onChange={(e) => set({ memory_mb: e.target.value })} /></Field>
          <Field id="cpus" label="CPU limit"><Input id="cpus" inputMode="decimal" value={f.cpus} onChange={(e) => set({ cpus: e.target.value })} /></Field>
          <Field id="max_restarts" label="Automatic restarts" hint="Crashes allowed within 10 minutes before the app is marked crashed. 0 = never restart by itself.">
            <Input id="max_restarts" inputMode="numeric" value={f.max_restarts} onChange={(e) => set({ max_restarts: e.target.value })} />
          </Field>
          <Field id="build_timeout_minutes" label="Build time limit (minutes)" hint="Leave empty for no limit. Otherwise a clone and build that take longer than this (5 to 10080) are stopped and the deployment fails. With no limit, a build that hangs blocks other deployments until you cancel it.">
            <Input id="build_timeout_minutes" inputMode="numeric" placeholder="no limit" value={f.build_timeout_minutes} onChange={(e) => set({ build_timeout_minutes: e.target.value })} />
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

      {mutation.isError && (
        <div role="alert" className="space-y-1 text-sm text-destructive">
          <p>{mutation.error.message}</p>
          {mutation.error.body?.details?.length > 0 && <ul className="list-disc pl-5">{mutation.error.body.details.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onBack}>Back</Button>
        <Button variant="ghost" asChild><Link to="/">Cancel</Link></Button>
        <Button type="submit" disabled={mutation.isPending || !canCreate}>{mutation.isPending ? 'Creating…' : 'Create app'}</Button>
      </div>
    </form>
  )
}
