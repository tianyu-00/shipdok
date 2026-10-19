import { useState } from 'react'
import { Ship } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { api } from '@/lib/api'
import { ThemeToggle } from '@/components/theme-toggle'
import { PasswordHelp } from '@/components/password-help'
import { RecoverForm } from '@/components/recover-form'
import { RecoveryCodes } from '@/components/recovery-codes'

// First run: create the one administrator. Afterwards: log in.
export default function AuthPage({ status }) {
  const client = useQueryClient()
  const setup = status.needsSetup
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [token, setToken] = useState('')
  const [localError, setLocalError] = useState(null)
  const [recovering, setRecovering] = useState(false)
  const [codes, setCodes] = useState(null) // shown once after setup, before the dashboard

  const finish = () => client.invalidateQueries({ queryKey: ['auth'] })
  const submit = useMutation({
    mutationFn: () => (setup
      ? api('/auth/setup', { method: 'POST', body: { username, password, ...(token ? { setupToken: token } : {}) } })
      : api('/auth/login', { method: 'POST', body: { username, password } })),
    onSuccess: (data) => (data?.recoveryCodes ? setCodes(data.recoveryCodes) : finish()),
  })

  const onSubmit = (e) => {
    e.preventDefault()
    setLocalError(null)
    if (setup && password !== confirm) return setLocalError('The two passwords are not the same')
    submit.mutate()
  }
  const error = localError ?? submit.error?.message

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <div className="absolute right-4 top-4"><ThemeToggle /></div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Ship className="size-5 text-primary" aria-hidden="true" />Shipdok</CardTitle>
          <CardDescription>{codes ? 'Save your recovery codes.' : recovering ? 'Recover your account.' : setup ? 'Create the administrator account to get started.' : 'Log in to manage your apps.'}</CardDescription>
        </CardHeader>
        <CardContent>
          {codes ? <RecoveryCodes codes={codes} onDone={finish} /> : recovering ? <RecoverForm onBack={() => setRecovering(false)} /> : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {status.expired && !setup && (
              <Alert><AlertDescription>Your session ended. Please log in again.</AlertDescription></Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
              {setup && <PasswordHelp value={password} />}
            </div>
            {setup && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="confirm">Repeat the password</Label>
                  <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="token">Setup token (only if your server asks for one)</Label>
                  <Input id="token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
                </div>
              </>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={submit.isPending}>
              {submit.isPending ? 'Please wait…' : setup ? 'Create account' : 'Log in'}
            </Button>
            {!setup && <Button type="button" variant="link" className="w-full" onClick={() => setRecovering(true)}>Lost your password? Use a recovery code</Button>}
          </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
