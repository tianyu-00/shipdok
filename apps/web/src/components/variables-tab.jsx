import { useState } from 'react'
import { Eye, EyeOff, FileUp, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Empty, ListSkeleton, LoadError } from '@/components/states'

const enc = encodeURIComponent

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
  const [draft, setDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const reveal = useMutation({
    mutationFn: () => api(`/apps/${appId}/env/${enc(variable.key)}/reveal`, { method: 'POST' }),
    onSuccess: (r) => setShown(r.value),
    onError: (err) => toast.error(err.message),
  })
  const save = useMutation({
    mutationFn: () => api(`/apps/${appId}/env/${enc(variable.key)}`, { method: 'PUT', body: { value: draft } }),
    onSuccess: () => { setEditing(false); setDraft(''); setShown(null); toast.success(`${variable.key} saved`); onChanged() },
    onError: (err) => toast.error(err.message),
  })
  const remove = useMutation({
    mutationFn: () => api(`/apps/${appId}/env/${enc(variable.key)}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success(`${variable.key} deleted`); onChanged() },
    onError: (err) => toast.error(err.message),
  })

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{variable.key}</TableCell>
      <TableCell className="font-mono text-xs">
        {editing ? (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
            <Input aria-label={`New value for ${variable.key}`} type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
            <Button type="submit" size="sm" disabled={save.isPending}>Save</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft('') }}>Cancel</Button>
          </form>
        ) : shown !== null ? (
          <span className="break-all" data-testid="revealed">{shown === '' ? '(empty)' : shown}</span>
        ) : <span aria-label="hidden value">{variable.value}</span>}
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">{timeAgo(variable.updated_at)}</TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          {shown !== null
            ? <Button variant="ghost" size="icon-sm" aria-label={`Hide ${variable.key}`} onClick={() => setShown(null)}><EyeOff className="size-4" /></Button>
            : <Button variant="ghost" size="icon-sm" aria-label={`Show ${variable.key}`} disabled={reveal.isPending} onClick={() => reveal.mutate()}><Eye className="size-4" /></Button>}
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${variable.key}`} onClick={() => setEditing(true)}><Pencil className="size-4" /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${variable.key}`} onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" /></Button>
        </div>
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
  const add = useMutation({
    mutationFn: () => api(`/apps/${appId}/env/${enc(key.trim())}`, { method: 'PUT', body: { value } }),
    onSuccess: () => { toast.success(`${key.trim()} saved`); setKey(''); setValue(''); onChanged() },
    onError: (err) => toast.error(err.message),
  })
  return (
    <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); if (key.trim()) add.mutate() }}>
      <div className="space-y-1.5 sm:w-64">
        <Label htmlFor="var-key">Name</Label>
        <Input id="var-key" className="font-mono" placeholder="DATABASE_URL" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <Label htmlFor="var-value">Value</Label>
        <Input id="var-value" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
      <Button type="submit" disabled={add.isPending || !key.trim()}>Add or update</Button>
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
        <p className="text-sm text-muted-foreground">Passed to the app as environment variables. Values are stored encrypted and shown only when you ask.</p>
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
