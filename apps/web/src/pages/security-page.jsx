import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, KeyRound, LogOut, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { useLogins } from '@/lib/queries'
import { shortAddress, timeAgo } from '@/lib/format'
import { forgetSession } from '@/lib/session'
import { ChangePasswordDialog } from '@/components/change-password-dialog'
import { Empty, ListSkeleton, LoadError } from '@/components/states'

const KIND = { setup: 'Account created', recovery: 'Recovery code used' }

function Result({ login }) {
  if (!login.success) return <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">Failed</Badge>
  return <Badge variant="outline" className="border-success/40 bg-success/10 text-success">{KIND[login.kind] ?? 'Signed in'}</Badge>
}

function SignOutEverywhere() {
  const client = useQueryClient()
  const [asking, setAsking] = useState(false)
  const out = useMutation({
    mutationFn: () => api('/auth/logout-all', { method: 'POST' }),
    onSuccess: () => forgetSession(client),
    onError: (err) => { toast.error(err.message); setAsking(false) },
  })
  return (
    <>
      <Button variant="outline" onClick={() => setAsking(true)}><LogOut className="size-4" aria-hidden="true" />Sign out everywhere</Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out everywhere?</AlertDialogTitle>
            <AlertDialogDescription>
              Every browser and device that is logged in is signed out, this browser too. You will need to log in again. Use this if you think someone else has your session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); out.mutate() }}>Sign out everywhere</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export default function SecurityPage() {
  const logins = useLogins()
  const [changing, setChanging] = useState(false)
  return (
    <div className="space-y-6">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />All apps</Link>
      <h1 className="text-2xl font-semibold">Security</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4" aria-hidden="true" />Your login</CardTitle>
          <CardDescription>
            There is no second login step: the password is the only protection, and anyone who gets in can run programs on this machine through your apps.
            Keep it long and unique. After a few wrong tries the next ones have to wait, and the wait grows.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setChanging(true)}><KeyRound className="size-4" aria-hidden="true" />Change password</Button>
          <SignOutEverywhere />
        </CardContent>
      </Card>
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent sign-ins</CardTitle>
          <CardDescription>The latest attempts to log in, including wrong ones and names that do not exist. If you see an address you do not know, change your password and sign out everywhere.</CardDescription>
        </CardHeader>
        <CardContent>
          {logins.isPending && <ListSkeleton rows={2} />}
          {logins.isError && <LoadError error={logins.error} title="Could not load the sign-ins" onRetry={() => logins.refetch()} />}
          {logins.data && (logins.data.logins.length === 0 ? <Empty title="No sign-ins recorded yet" /> : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>When</TableHead><TableHead>Name</TableHead><TableHead>From</TableHead><TableHead>Result</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {logins.data.logins.map((l, i) => (
                    <TableRow key={`${l.at}-${i}`}>
                      <TableCell className="whitespace-nowrap" title={new Date(l.at).toLocaleString()}>{timeAgo(l.at)}</TableCell>
                      <TableCell className="break-all">{l.username}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{shortAddress(l.address)}</TableCell>
                      <TableCell><Result login={l} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
