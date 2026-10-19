import { useState } from 'react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'

/** Forget the GitHub App. Needs the password. Running apps are not touched. */
export function GithubDisconnectDialog({ onClose }) {
  const client = useQueryClient()
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState(null)
  const disconnect = useMutation({
    mutationFn: () => api('/github', { method: 'DELETE', body: { password } }),
    onSuccess: () => {
      toast.success('GitHub disconnected')
      client.invalidateQueries({ queryKey: ['github'] })
      client.invalidateQueries({ queryKey: ['github-webhook'] })
      client.invalidateQueries({ queryKey: ['logins'] })
      client.invalidateQueries({ queryKey: ['repos'] })
      onClose()
    },
  })
  const submit = (e) => {
    e.preventDefault()
    if (!password) return setProblem('Enter your current password')
    setProblem(null)
    if (!disconnect.isPending) disconnect.mutate()
  }
  const error = problem ?? disconnect.error?.message
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect GitHub?</DialogTitle>
          <DialogDescription>
            Shipdok forgets the app's key and webhook secret. Apps that are already running keep running. New builds of private repositories will fail, and pushes
            will no longer start deployments, until GitHub is connected again. Shipdok cannot delete the app on GitHub: delete the app on GitHub yourself if you no longer want it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="gd-password">Current password</Label>
            <Input id="gd-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={disconnect.isPending}>{disconnect.isPending ? 'Please wait…' : 'Disconnect'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
