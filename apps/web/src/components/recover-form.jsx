import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { PasswordHelp } from '@/components/password-help'

/** Lost the password: a recovery code and a new password. A good code logs this browser in. */
export function RecoverForm({ onBack }) {
  const client = useQueryClient()
  const [f, setF] = useState({ username: '', code: '', next: '', repeat: '' })
  const [localError, setLocalError] = useState(null)
  const set = (k) => (e) => setF((old) => ({ ...old, [k]: e.target.value }))
  const recover = useMutation({
    mutationFn: () => api('/auth/recover', { method: 'POST', body: { username: f.username, code: f.code, newPassword: f.next } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['auth'] }),
  })
  const submit = (e) => {
    e.preventDefault()
    setLocalError(null)
    if (f.next.length < 12) return setLocalError('The new password must be at least 12 characters')
    if (f.next !== f.repeat) return setLocalError('The two passwords are not the same')
    recover.mutate()
  }
  const error = localError ?? recover.error?.message
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm text-muted-foreground">Use one of the recovery codes you saved when you made your account. Every other session is signed out, and the code cannot be used again.</p>
      <div className="space-y-2">
        <Label htmlFor="rc-username">Username</Label>
        <Input id="rc-username" autoComplete="username" value={f.username} onChange={set('username')} autoFocus />
      </div>
      <div className="space-y-2">
        <Label htmlFor="rc-code">Recovery code</Label>
        <Input id="rc-code" autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX" value={f.code} onChange={set('code')} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="rc-new">New password</Label>
        <Input id="rc-new" type="password" autoComplete="new-password" value={f.next} onChange={set('next')} />
        <PasswordHelp value={f.next} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="rc-repeat">Repeat the new password</Label>
        <Input id="rc-repeat" type="password" autoComplete="new-password" value={f.repeat} onChange={set('repeat')} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={recover.isPending}>{recover.isPending ? 'Please wait…' : 'Set new password and log in'}</Button>
      <Button type="button" variant="link" className="w-full" onClick={onBack}>Back to log in</Button>
    </form>
  )
}
