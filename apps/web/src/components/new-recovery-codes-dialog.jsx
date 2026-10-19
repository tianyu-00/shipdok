import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { RecoveryCodes } from '@/components/recovery-codes'

/** Asks for the current password, makes a new set of ten (the old ones stop working) and shows it once. */
export function NewRecoveryCodesDialog({ onClose }) {
  const client = useQueryClient()
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState(null)
  const [codes, setCodes] = useState(null)
  const make = useMutation({
    mutationFn: () => api('/auth/recovery', { method: 'POST', body: { password } }),
    onSuccess: (data) => setCodes(data.codes),
  })
  const submit = (e) => {
    e.preventDefault()
    if (!password) return setProblem('Enter your current password')
    setProblem(null)
    if (!make.isPending) make.mutate()
  }
  const done = () => { client.invalidateQueries({ queryKey: ['recovery'] }); onClose() }
  const error = problem ?? make.error?.message
  // Once the codes are on screen they can never be shown again, so nothing but "I have saved these" may close the dialog.
  const hold = codes ? { onEscapeKeyDown: (e) => e.preventDefault(), onInteractOutside: (e) => e.preventDefault(), showCloseButton: false } : {}
  return (
    <Dialog open onOpenChange={(open) => !open && !codes && onClose()}>
      <DialogContent {...hold}>
        <DialogHeader>
          <DialogTitle>{codes ? 'Your new recovery codes' : 'Make new recovery codes'}</DialogTitle>
          <DialogDescription>{codes ? 'The old codes no longer work.' : 'You get ten new codes. The old codes stop working as soon as these are made.'}</DialogDescription>
        </DialogHeader>
        {codes ? <RecoveryCodes codes={codes} onDone={done} /> : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="nrc-password">Current password</Label>
              <Input id="nrc-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={make.isPending}>{make.isPending ? 'Please wait…' : 'Make new codes'}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
