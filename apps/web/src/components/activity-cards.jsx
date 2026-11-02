import { useState } from 'react'
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
import { useLogins } from '@/lib/queries'
import { shortAddress, timeAgo } from '@/lib/format'
import { pageOf } from '@/lib/backups'
import { savedPageSize, savePageSize } from '@/lib/paging'
import { Empty, ListSkeleton, LoadError } from '@/components/states'
import { Field } from '@/components/field'
import { Pager } from '@/components/pager'
import { Select } from '@/components/select'

const SIGNIN_KIND = { login: 'Signed in', setup: 'Account created', recovery: 'Recovery code used', reset: 'Password reset on the host' }
const ACTIVITY_KIND = {
  settings: 'Public access changed', github: 'GitHub changed', backup: 'Backup passphrase changed', download: 'Backup downloaded',
  restore: 'Restore started', logsettings: 'Log keeping time changed',
}
const KEEP_CHOICES = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']]

function Result({ row, names }) {
  if (!row.success) return <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">Failed</Badge>
  return <Badge variant="outline" className="border-success/40 bg-success/10 text-success">{names[row.kind] ?? row.kind}</Badge>
}

/** A paged table of one scope of the log. `after` is drawn under the description (the keeping-time choice). */
function LogCard({ scope, title, description, emptyTitle, nameHeading, resultHeading, names, sizeKey, children }) {
  const logins = useLogins(scope)
  const [size, setSize] = useState(() => savedPageSize(sizeKey))
  const [at, setAt] = useState(0)
  const rows = logins.data?.logins ?? []
  const { items, page, pages } = pageOf(rows, at, size)
  return (
    <Card aria-label={title}>
      <CardHeader>
        <CardTitle className="text-base">{title}{logins.data && rows.length > 0 && <span className="ml-2 text-sm font-normal text-muted-foreground">({rows.length})</span>}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {children}
        {logins.isPending && <ListSkeleton rows={2} />}
        {logins.isError && <LoadError error={logins.error} title={`Could not load the ${title.toLowerCase()}`} onRetry={() => logins.refetch()} />}
        {logins.data && (rows.length === 0 ? <Empty title={emptyTitle} /> : (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>When</TableHead><TableHead>{nameHeading}</TableHead><TableHead>From</TableHead><TableHead>{resultHeading}</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((l, i) => (
                    <TableRow key={`${l.at}-${page}-${i}`}>
                      <TableCell className="whitespace-nowrap" title={new Date(l.at).toLocaleString()}>{timeAgo(l.at)}</TableCell>
                      <TableCell className="break-all">{l.username}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{shortAddress(l.address)}</TableCell>
                      <TableCell><Result row={l} names={names} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pager
              id={`${scope}-page-size`} count={rows.length} page={page} pages={pages} size={size} onPage={setAt}
              onSize={(n) => { setSize(n); savePageSize(sizeKey, n); setAt(0) }}
            />
          </>
        ))}
      </CardContent>
    </Card>
  )
}

export function SignInsCard() {
  return (
    <LogCard
      scope="signins" title="Sign-ins" sizeKey="shipdok.signinsPageSize" names={SIGNIN_KIND} nameHeading="Name" resultHeading="Result" emptyTitle="No sign-ins recorded yet"
      description="The latest attempts to log in, including wrong ones and names that do not exist. If you see an address you do not know, change your password and sign out everywhere."
    />
  )
}

/** Changing how long rows are kept asks for the password: a shorter time deletes older rows at once. */
function KeepDialog({ days, onClose }) {
  const client = useQueryClient()
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState(null)
  const save = useMutation({
    mutationFn: () => api('/auth/logins/settings', { method: 'PUT', body: { password, keepDays: days } }),
    onSuccess: () => { toast.success('Saved.'); client.invalidateQueries({ queryKey: ['logins'] }); onClose() },
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

export function ActivityCard() {
  const logins = useLogins('activity')
  const [asking, setAsking] = useState(null)
  const days = logins.data?.keepDays
  return (
    <>
      <LogCard
        scope="activity" title="Activity log" sizeKey="shipdok.activityPageSize" names={ACTIVITY_KIND} nameHeading="Who" resultHeading="What" emptyTitle="No activity recorded yet"
        description="What was done with your password: changing the backup passphrase, connecting GitHub, changing public access, downloading a backup, restoring one. If you see something you did not do, change your password and sign out everywhere."
      >
        {days !== undefined && (
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="keep-days" className="text-muted-foreground">Keep the sign-ins and this log for</label>
            <div className="w-32"><Select id="keep-days" value={String(days)} onChange={(v) => { if (Number(v) !== days) setAsking(Number(v)) }}>
              {KEEP_CHOICES.map(([d, text]) => <option key={d} value={d}>{text}</option>)}
            </Select></div>
          </div>
        )}
      </LogCard>
      {asking !== null && <KeepDialog days={asking} onClose={() => setAsking(null)} />}
    </>
  )
}
