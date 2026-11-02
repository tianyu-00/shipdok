import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { useAudit, useLogins } from '@/lib/queries'
import { AUDIT_CATEGORIES, categoryLabel, detailText } from '@/lib/audit'
import { shortAddress, timeAgo } from '@/lib/format'
import { pageOf } from '@/lib/backups'
import { savedPageSize, savePageSize } from '@/lib/paging'
import { Empty, ListSkeleton, LoadError } from '@/components/states'
import { Field } from '@/components/field'
import { Pager } from '@/components/pager'
import { Select } from '@/components/select'

const SIGNIN_KIND = { login: 'Signed in', setup: 'Account created', recovery: 'Recovery code used', reset: 'Password reset on the host' }
const KEEP_CHOICES = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']]

function Result({ row }) {
  if (!row.success) return <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">Failed</Badge>
  return <Badge variant="outline" className="border-success/40 bg-success/10 text-success">{SIGNIN_KIND[row.kind] ?? row.kind}</Badge>
}

/** Page size of a list, remembered in this browser under `sizeKey`, and the page being looked at. */
function usePaging(sizeKey) {
  const [size, setSize] = useState(() => savedPageSize(sizeKey))
  const [at, setAt] = useState(0)
  return { size, at, setAt, setSize: (n) => { setSize(n); savePageSize(sizeKey, n); setAt(0) } }
}

export function SignInsCard() {
  const logins = useLogins()
  const paging = usePaging('shipdok.signinsPageSize')
  const rows = logins.data?.logins ?? []
  const { items, page, pages } = pageOf(rows, paging.at, paging.size)
  return (
    <Card aria-label="Sign-ins">
      <CardHeader>
        <CardTitle className="text-base">Sign-ins{logins.data && rows.length > 0 && <span className="ml-2 text-sm font-normal text-muted-foreground">({rows.length})</span>}</CardTitle>
        <CardDescription>The latest attempts to log in, including wrong ones and names that do not exist. If you see an address you do not know, change your password and sign out everywhere.</CardDescription>
      </CardHeader>
      <CardContent>
        {logins.isPending && <ListSkeleton rows={2} />}
        {logins.isError && <LoadError error={logins.error} title="Could not load the sign-ins" onRetry={() => logins.refetch()} />}
        {logins.data && (rows.length === 0 ? <Empty title="No sign-ins recorded yet" /> : (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>When</TableHead><TableHead>Name</TableHead><TableHead>From</TableHead><TableHead>Result</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((l, i) => (
                    <TableRow key={`${l.at}-${page}-${i}`}>
                      <TableCell className="whitespace-nowrap" title={new Date(l.at).toLocaleString()}>{timeAgo(l.at)}</TableCell>
                      <TableCell className="break-all">{l.username}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{shortAddress(l.address)}</TableCell>
                      <TableCell><Result row={l} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pager id="signins-page-size" count={rows.length} page={page} pages={pages} size={paging.size} onPage={paging.setAt} onSize={paging.setSize} />
          </>
        ))}
      </CardContent>
    </Card>
  )
}

/** Changing how long rows are kept asks for the password: a shorter time deletes older rows at once. */
function KeepDialog({ days, onClose }) {
  const client = useQueryClient()
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState(null)
  const save = useMutation({
    mutationFn: () => api('/auth/logins/settings', { method: 'PUT', body: { password, keepDays: days } }),
    onSuccess: () => { toast.success('Saved.'); for (const key of [['logins'], ['audit']]) client.invalidateQueries({ queryKey: key }); onClose() },
    onError: (err) => setProblem(err.message),
  })
  const label = KEEP_CHOICES.find(([d]) => d === days)?.[1]
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <form onSubmit={(e) => { e.preventDefault(); setProblem(null); if (password) save.mutate() }} noValidate className="space-y-4">
          <AlertDialogHeader>
            <AlertDialogTitle>Keep the sign-ins and the activity for {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Entries older than that are deleted from both lists, now and whenever something new is recorded. A shorter time removes older entries at once and cannot be undone. This change is recorded in the activity log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field id="keep-days-password" label="Your password" error={problem}>
            <Input id="keep-days-password" type="password" autoComplete="current-password" autoFocus value={password} aria-invalid={problem ? true : undefined} onChange={(e) => { setPassword(e.target.value); setProblem(null) }} />
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <Button type="submit" disabled={!password || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** One entry of the activity log: its category, when, who and from where, the summary, and when it has details an arrow that shows them (what changed, what was affected). */
function Entry({ entry }) {
  const [open, setOpen] = useState(false)
  const has = entry.details.length > 0
  return (
    <li className="p-3">
      <div className="flex items-start gap-2">
        {has
          ? <Button variant="ghost" size="icon-sm" className="-ml-1 shrink-0" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the details of: ${entry.summary}`} onClick={() => setOpen(!open)}>{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</Button>
          : <span className="w-7 shrink-0" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge variant="outline">{categoryLabel(entry.category)}</Badge>
            <span title={new Date(entry.at).toLocaleString()}>{timeAgo(entry.at)}</span>
            <span aria-hidden="true">·</span>
            <span className="break-all">{entry.actor}</span>
            <span className="font-mono">{shortAddress(entry.address)}</span>
          </div>
          <p className="mt-1 break-words text-sm">{entry.summary}</p>
          {open && (
            <ul aria-label={`Details of: ${entry.summary}`} className="mt-2 space-y-1 rounded-md bg-muted/40 p-3 text-sm">
              {entry.details.map((d, i) => <li key={i} className="break-words">{detailText(d)}</li>)}
            </ul>
          )}
        </div>
      </div>
    </li>
  )
}

export function ActivityCard() {
  const [category, setCategory] = useState(undefined)
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 300); return () => clearTimeout(t) }, [text])
  const audit = useAudit({ category, q })
  const paging = usePaging('shipdok.activityPageSize')
  const [asking, setAsking] = useState(null)
  const entries = audit.data?.entries ?? []
  const days = audit.data?.keepDays
  const { items, page, pages } = pageOf(entries, paging.at, paging.size)
  const filtered = category !== undefined || q !== ''
  const choose = (value) => { setCategory(value); paging.setAt(0) }
  return (
    <>
      <Card aria-label="Activity log">
        <CardHeader>
          <CardTitle className="text-base">Activity log{audit.data && entries.length > 0 && <span className="ml-2 text-sm font-normal text-muted-foreground">({entries.length})</span>}</CardTitle>
          <CardDescription>
            What was done with your password, and what it changed: backup passphrase, GitHub, public access, downloads and restores. Open an entry to see the details. If you see something you did not do, change your password and sign out everywhere.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {days !== undefined && (
            <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
              <label htmlFor="keep-days" className="text-muted-foreground">Keep the sign-ins and this log for</label>
              <div className="w-32"><Select id="keep-days" value={String(days)} onChange={(v) => { if (Number(v) !== days) setAsking(Number(v)) }}>
                {KEEP_CHOICES.map(([d, label]) => <option key={d} value={d}>{label}</option>)}
              </Select></div>
            </div>
          )}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Category" className="flex flex-wrap gap-1.5">
              {[{ value: undefined, label: 'All' }, ...AUDIT_CATEGORIES].map((c) => (
                <Button key={c.label} type="button" size="sm" variant={category === c.value ? 'default' : 'outline'} aria-pressed={category === c.value} onClick={() => choose(c.value)}>{c.label}</Button>
              ))}
            </div>
            <div className="relative ml-auto w-full sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input aria-label="Search the activity log" placeholder="Search" className="pl-8" value={text} maxLength={100} onChange={(e) => { setText(e.target.value); paging.setAt(0) }} />
            </div>
          </div>
          {audit.isPending && <ListSkeleton rows={2} />}
          {audit.isError && <LoadError error={audit.error} title="Could not load the activity log" onRetry={() => audit.refetch()} />}
          {audit.data && (entries.length === 0 ? <Empty title={filtered ? 'Nothing matches' : 'No activity recorded yet'} /> : (
            <>
              <ul aria-label="Entries" className="divide-y rounded-lg border">
                {items.map((e) => <Entry key={e.id} entry={e} />)}
              </ul>
              <Pager id="activity-page-size" count={entries.length} page={page} pages={pages} size={paging.size} onPage={paging.setAt} onSize={paging.setSize} />
            </>
          ))}
        </CardContent>
      </Card>
      {asking !== null && <KeepDialog days={asking} onClose={() => setAsking(null)} />}
    </>
  )
}
