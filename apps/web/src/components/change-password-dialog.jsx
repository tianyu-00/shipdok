import { useState } from 'react'
import { toast } from 'sonner'
import { useMutation } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { PasswordHelp } from '@/components/password-help'

/** The checks the server also makes, done first so a typo does not cost a request (and a rate-limit attempt). */
export function passwordProblem({ current, next, repeat }) {
  if (!current) return 'Enter your current password'
  if (next.length < 12) return 'The new password must be at least 12 characters'
  if (next.length > 256) return 'The new password can be at most 256 characters'
  if (next === current) return 'The new password must be different from the current one'
  if (next !== repeat) return 'The two new passwords are not the same'
  return null
}

export function ChangePasswordDialog({ onClose }) {
  const [f, setF] = useState({ current: '', next: '', repeat: '' })
  const [problem, setProblem] = useState(null)
  const change = useMutation({
    mutationFn: () => api('/auth/password', { method: 'POST', body: { currentPassword: f.current, newPassword: f.next } }),
    onSuccess: () => { toast.success('Password changed. Other sessions were signed out.'); onClose() },
  })
  const set = (k) => (e) => setF((old) => ({ ...old, [k]: e.target.value }))
  const submit = (e) => {
    e.preventDefault()
    const p = passwordProblem(f)
    setProblem(p)
    if (!p && !change.isPending) change.mutate()
  }
  const error = problem ?? change.error?.message
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>Every other browser or device that is logged in will be signed out. This one stays logged in.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="cp-current">Current password</Label>
            <Input id="cp-current" type="password" autoComplete="current-password" value={f.current} onChange={set('current')} autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-new">New password</Label>
            <Input id="cp-new" type="password" autoComplete="new-password" value={f.next} onChange={set('next')} />
            <PasswordHelp value={f.next} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-repeat">Repeat the new password</Label>
            <Input id="cp-repeat" type="password" autoComplete="new-password" value={f.repeat} onChange={set('repeat')} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={change.isPending}>{change.isPending ? 'Please wait…' : 'Change password'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
