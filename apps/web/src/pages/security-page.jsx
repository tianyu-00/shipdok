import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, KeyRound, LifeBuoy, LogOut, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { useRecovery } from '@/lib/queries'
import { forgetSession } from '@/lib/session'
import { ChangePasswordDialog } from '@/components/change-password-dialog'
import { NewRecoveryCodesDialog } from '@/components/new-recovery-codes-dialog'
import { PublicAccessCard } from '@/components/public-access-card'
import { SignInsCard, ActivityCard } from '@/components/activity-cards'
import { LoadError } from '@/components/states'

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

function RecoveryCard() {
  const recovery = useRecovery()
  const [making, setMaking] = useState(false)
  const left = recovery.data?.remaining
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><LifeBuoy className="size-4" aria-hidden="true" />Recovery codes</CardTitle>
        <CardDescription>
          If you forget your password, a recovery code lets you set a new one from the login screen. Each code works once, and the codes are shown only when they are made.
          If you lose the codes too, run <code className="rounded bg-muted px-1 py-0.5 text-xs">docker compose -f infrastructure/compose.yaml --env-file infrastructure/.env exec api node scripts/reset-password.js</code> on the machine running Shipdok: it prints a new password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {recovery.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {recovery.isError && <LoadError error={recovery.error} title="Could not load the recovery codes" onRetry={() => recovery.refetch()} />}
        {recovery.data && (
          <>
            <p className="text-sm">
              {left === 0 ? <span className="font-medium text-destructive">You have no recovery codes left.</span> : <span className="font-medium">{left} of 10 recovery codes left</span>}
              {recovery.data.createdAt && <span className="text-muted-foreground"> (made {new Date(recovery.data.createdAt).toLocaleDateString()})</span>}
            </p>
            {left > 0 && left <= 3 && <p className="text-sm text-warning">Only {left} left: make a new set before they run out.</p>}
          </>
        )}
        <Button variant="outline" onClick={() => setMaking(true)}>Make new codes</Button>
        {making && <NewRecoveryCodesDialog onClose={() => setMaking(false)} />}
      </CardContent>
    </Card>
  )
}

export default function SecurityPage() {
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

      <RecoveryCard />

      <PublicAccessCard />

      <SignInsCard />

      <ActivityCard />
    </div>
  )
}
