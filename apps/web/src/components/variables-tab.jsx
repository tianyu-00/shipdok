import { useState } from 'react'
import { ChevronDown, Eye, EyeOff, FileUp, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { useEnv } from '@/lib/queries'
import { timeAgo } from '@/lib/format'
import { SCOPES, scopeLabel, scopeBadgeClass, reachesBuild, buildNameProblem, nameFormatProblem } from '@/lib/env-scope'
import { Empty, ListSkeleton, LoadError } from '@/components/states'

const enc = encodeURIComponent

// A plain <select> (accessible, and good on a phone) drawn like the inputs, with its own arrow instead of the browser's.
function ScopeSelect({ id, value, onChange, disabled, label }) {
  return (
    <div className="relative">
      <select
        id={id} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full appearance-none rounded-md border border-input bg-transparent pl-3 pr-9 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
      >
        {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
    </div>
  )
}

const BAKED_TITLE = 'Build variables are baked into the image'
const BAKED_WARNING = 'If the Dockerfile uses it (declare it with ARG NAME), the value ends up in the image, readable by anyone who can read the image. Fine for public settings such as VITE_API_URL, not for secrets. The running container only gets it with "Build and runtime".'

function BakedNotice() {
  return (
    <Alert role="note" className="border-warning/50 text-warning">
      <AlertTitle className="line-clamp-none">{BAKED_TITLE}</AlertTitle>
      <AlertDescription>{BAKED_WARNING}</AlertDescription>
    </Alert>
  )
}

function PendingNotice({ pending }) {
  if (!pending?.pending) return null
  const part = (label, keys) => (keys.length ? <li>{label}: <span className="font-mono">{keys.join(', ')}</span></li> : null)
  return (
    <Alert className="border-warning/50 text-warning">
      <AlertTitle>These changes are not in the running app yet</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-5">
          {part('Added', pending.added)}{part('Changed', pending.changed)}{part('Removed', pending.removed)}
        </ul>
        <p className="mt-1">Press Deploy to apply them. Variables are read when a version is built and started.</p>
      </AlertDescription>
    </Alert>
  )
}

function VariableRow({ appId, variable, onChanged }) {
  const [shown, setShown] = useState(null) // the revealed value, while it is shown
  const [editing, setEditing] = useState(false)
  const current = variable.scope ?? 'runtime'
  const [draft, setDraft] = useState(null) // the new value, or null while the value has not been touched (it is then kept as it is)
  const [scopeDraft, setScopeDraft] = useState(current)
  const [nameDraft, setNameDraft] = useState(variable.key)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const startEditing = () => { setDraft(null); setScopeDraft(current); setNameDraft(variable.key); setEditing(true) }
  const stopEditing = () => setEditing(false) // startEditing begins from the saved state again, so nothing typed survives
  const newName = nameDraft.trim()
  const nameChanged = newName !== variable.key
  const scopeChanged = scopeDraft !== current
  // A name that cannot be used at build time may stay a runtime variable, but cannot be moved to the build, or given to a build variable.
  const nameProblem = (nameChanged ? nameFormatProblem(newName) : null)
    ?? ((nameChanged || scopeChanged) && reachesBuild(scopeDraft) ? buildNameProblem(newName) : null)
  const nothingToSave = draft === null && !scopeChanged && !nameChanged

  const reveal = useMutation({
    mutationFn: () => api(`/apps/${appId}/env/${enc(variable.key)}/reveal`, { method: 'POST' }),
    onSuccess: (r) => setShown(r.value),
    onError: (err) => toast.error(err.message),
  })
  const save = useMutation({
    // Only what was changed is sent: the API keeps the rest. A rename keeps the stored value too (the server decrypts and encrypts it again).
    mutationFn: () => api(`/apps/${appId}/env/${enc(variable.key)}`, {
      method: 'PUT', body: { ...(draft !== null ? { value: draft } : {}), ...(scopeChanged ? { scope: scopeDraft } : {}), ...(nameChanged ? { newKey: newName } : {}) },
    }),
    onSuccess: () => { stopEditing(); setShown(null); toast.success(`${variable.key} saved`); onChanged() },
    onError: (err) => toast.error(err.message),
  })
  const remove = useMutation({
    mutationFn: () => api(`/apps/${appId}/env/${enc(variable.key)}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success(`${variable.key} deleted`); onChanged() },
    onError: (err) => toast.error(err.message),
  })

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span>{variable.key}</span>
          <Badge variant="outline" data-testid="scope-badge" className={`font-sans ${scopeBadgeClass(variable.scope)}`}>{scopeLabel(variable.scope)}</Badge>
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs">
        {shown !== null ? (
          <span className="break-all" data-testid="revealed">{shown === '' ? '(empty)' : shown}</span>
        ) : <span aria-label="hidden value">{variable.value}</span>}
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">{timeAgo(variable.updated_at)}</TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          {shown !== null
            ? <Button variant="ghost" size="icon-sm" aria-label={`Hide ${variable.key}`} onClick={() => setShown(null)}><EyeOff className="size-4" /></Button>
            : <Button variant="ghost" size="icon-sm" aria-label={`Show ${variable.key}`} disabled={reveal.isPending} onClick={() => reveal.mutate()}><Eye className="size-4" /></Button>}
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${variable.key}`} onClick={startEditing}><Pencil className="size-4" /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${variable.key}`} onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" /></Button>
        </div>
        <Dialog open={editing} onOpenChange={(open) => !open && stopEditing()}>
          <DialogContent>
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!nothingToSave && !nameProblem) save.mutate() }}>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2"><span className="font-mono">{variable.key}</span><Badge variant="outline" data-testid="scope-badge" className={scopeBadgeClass(variable.scope)}>{scopeLabel(variable.scope)}</Badge></DialogTitle>
                <DialogDescription>Change the name, the value, where it is available, or any of them. Changes apply from the next deployment.</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Label htmlFor={`edit-name-${variable.key}`}>Name</Label>
                <Input id={`edit-name-${variable.key}`} aria-label={`Name of ${variable.key}`} className="font-mono" autoComplete="off" spellCheck={false} value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
                {nameChanged && !nameProblem && <p className="text-xs text-muted-foreground">The running app keeps the old name until the next deployment.</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`edit-value-${variable.key}`}>New value</Label>
                <Input id={`edit-value-${variable.key}`} aria-label={`New value for ${variable.key}`} type="password" autoComplete="off" value={draft ?? ''} onChange={(e) => setDraft(e.target.value)} autoFocus />
                <p className="text-xs text-muted-foreground">Leave empty to keep the current value.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`edit-scope-${variable.key}`}>Available in</Label>
                <ScopeSelect id={`edit-scope-${variable.key}`} label={`Where ${variable.key} is available`} value={scopeDraft} onChange={setScopeDraft} />
              </div>
              {nameProblem && <p role="alert" className="text-sm text-destructive">{nameProblem}</p>}
              {reachesBuild(scopeDraft) && <BakedNotice />}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={stopEditing}>Cancel</Button>
                <Button type="submit" disabled={save.isPending || nothingToSave || nameProblem !== null}>Save</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {variable.key}?</AlertDialogTitle>
              <AlertDialogDescription>The running app keeps its current value until the next deployment.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  )
}

function AddForm({ appId, onChanged }) {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [scope, setScope] = useState('runtime')
  const add = useMutation({
    // The scope is always sent: what is chosen here is what the variable becomes, also when the name already exists.
    mutationFn: () => api(`/apps/${appId}/env/${enc(key.trim())}`, { method: 'PUT', body: { value, scope } }),
    onSuccess: () => { toast.success(`${key.trim()} saved`); setKey(''); setValue(''); setScope('runtime'); onChanged() },
    onError: (err) => toast.error(err.message),
  })
  const nameProblem = reachesBuild(scope) ? buildNameProblem(key) : null
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (key.trim() && !nameProblem) add.mutate() }}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="space-y-1.5 sm:w-64">
          <Label htmlFor="var-key">Name</Label>
          <Input id="var-key" className="font-mono" placeholder="DATABASE_URL" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="var-value">Value</Label>
          <Input id="var-value" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <div className="space-y-1.5 sm:w-44">
          <Label htmlFor="var-scope">Available in</Label>
          <ScopeSelect id="var-scope" value={scope} onChange={setScope} />
        </div>
        <Button type="submit" disabled={add.isPending || !key.trim() || nameProblem !== null}>Add or update</Button>
      </div>
      {nameProblem && <p role="alert" className="text-sm text-destructive">{nameProblem}</p>}
      {reachesBuild(scope) && <BakedNotice />}
    </form>
  )
}

function ImportDialog({ appId, open, onOpenChange, onChanged }) {
  const [content, setContent] = useState('')
  const [problems, setProblems] = useState(null)
  const run = useMutation({
    mutationFn: () => api(`/apps/${appId}/env/import`, { method: 'POST', body: { content } }),
    onSuccess: (r) => {
      toast.success(`Imported: ${r.created} added, ${r.updated} updated`)
      setContent(''); setProblems(null); onOpenChange(false); onChanged()
    },
    onError: (err) => setProblems({ message: err.message, list: err.body?.problems ?? [], total: err.body?.total_problems }),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a .env file</DialogTitle>
          <DialogDescription>Paste the file. Everything is checked first: if anything is wrong, nothing is saved.</DialogDescription>
        </DialogHeader>
        <Textarea aria-label=".env contents" rows={10} className="font-mono text-xs" value={content} onChange={(e) => setContent(e.target.value)} placeholder={'KEY=value\nOTHER=value'} />
        {problems && (
          <div role="alert" className="space-y-1 text-sm text-destructive">
            <p>{problems.message}</p>
            <ul className="list-disc pl-5">
              {problems.list.map((p, i) => <li key={i}>Line {p.line}: {p.message}</li>)}
            </ul>
            {problems.total > problems.list.length && <p>…and {problems.total - problems.list.length} more.</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={run.isPending || !content.trim()} onClick={() => run.mutate()}>Import</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function VariablesTab({ app }) {
  const client = useQueryClient()
  const env = useEnv(app.id)
  const [importing, setImporting] = useState(false)
  const changed = () => client.invalidateQueries({ queryKey: ['env', app.id] })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Environment variables for the app: passed to the running container, to the build (as build arguments), or both. Values are stored encrypted and shown only when you ask. An imported .env file is added as runtime variables.</p>
        <Button variant="outline" onClick={() => setImporting(true)}><FileUp className="size-4" />Import .env</Button>
      </div>
      {env.isPending && <ListSkeleton rows={2} />}
      {env.isError && <LoadError error={env.error} onRetry={() => env.refetch()} title="Could not load the variables" />}
      {env.data && (
        <>
          <PendingNotice pending={env.data.pending} />
          <AddForm appId={app.id} onChanged={changed} />
          {env.data.variables.length === 0 ? <Empty title="No variables yet" /> : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Value</TableHead><TableHead>Changed</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                <TableBody>
                  {env.data.variables.map((v) => <VariableRow key={v.key} appId={app.id} variable={v} onChanged={changed} />)}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
      <ImportDialog appId={app.id} open={importing} onOpenChange={setImporting} onChanged={changed} />
    </div>
  )
}
