import { useState } from 'react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'

/** Forget one GitHub app. Needs the password. Running apps are not touched; the projects that use it are listed first. */
export function GithubDisconnectDialog({ app, onClose }) {
  const client = useQueryClient()
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState(null)
  const disconnect = useMutation({
    mutationFn: () => api(`/github/apps/${app.id}`, { method: 'DELETE', body: { password } }),
    onSuccess: () => {
      toast.success(`${app.name ?? 'The GitHub app'} disconnected`)
      client.invalidateQueries({ queryKey: ['github'] })
      client.invalidateQueries({ queryKey: ['github-webhook'] })
      client.invalidateQueries({ queryKey: ['logins'] })
      client.invalidateQueries({ queryKey: ['repos'] })
      client.invalidateQueries({ queryKey: ['apps'] }) // the projects that used it have no GitHub app now
      client.invalidateQueries({ queryKey: ['app'] })
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
          <DialogTitle>Disconnect {app.name ?? 'this GitHub app'}?</DialogTitle>
          <DialogDescription>
            Shipdok forgets this app's key and webhook secret. Apps that are already running keep running. Shipdok cannot delete the app on GitHub: delete it there
            yourself if you no longer want it.
          </DialogDescription>
        </DialogHeader>
        {app.projects?.length > 0 ? (
          <div role="note" className="space-y-1 rounded-md border border-warning/50 p-3 text-sm text-warning">
            <p className="font-medium">{app.projects.length === 1 ? 'This project uses it' : `These ${app.projects.length} projects use it`} and will be left with no GitHub app:</p>
            <ul className="list-disc pl-5">{app.projects.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
            <p>New builds of their private repositories will fail, and pushes will not deploy them, until you give them another GitHub app in their settings.</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No project uses this GitHub app.</p>
        )}
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
