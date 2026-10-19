import { useState } from 'react'
import { Globe } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { usePublicAccess } from '@/lib/queries'
import { publicUrlProblem, webhookUrl } from '@/lib/publicaccess'
import { LoadError } from '@/components/states'

const MODES = [
  { value: 'local', title: 'Local only', text: 'Nothing is reachable from outside. Only this machine and your own network can open Shipdok.' },
  { value: 'webhook', title: 'Webhook only', text: 'From outside, only GitHub can reach the webhook, so pushes deploy. The dashboard stays private.' },
  { value: 'full', title: 'Full access', text: 'The whole dashboard is reachable from outside, on your public address. Use a long, unique password.' },
]

function ConfirmDialog({ body, onClose, onSaved }) {
  const client = useQueryClient()
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState(null)
  const save = useMutation({
    mutationFn: () => api('/settings/public', { method: 'PUT', body: { password, ...body } }),
    onSuccess: () => {
      toast.success('Public access saved')
      client.invalidateQueries({ queryKey: ['public-access'] })
      client.invalidateQueries({ queryKey: ['logins'] })
      onSaved()
    },
  })
  const submit = (e) => {
    e.preventDefault()
    if (!password) return setProblem('Enter your current password')
    setProblem(null)
    if (!save.isPending) save.mutate()
  }
  const error = problem ?? save.error?.message
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm with your password</DialogTitle>
          <DialogDescription>This changes who can reach Shipdok from outside, so your current password is asked again. The change is recorded in the sign-ins list.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="pa-password">Current password</Label>
            <Input id="pa-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Please wait…' : 'Confirm'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function PublicAccessCard() {
  const access = usePublicAccess()
  const [draft, setDraft] = useState({}) // only what the administrator has changed
  const [urlError, setUrlError] = useState(null)
  const [asking, setAsking] = useState(null) // the body to send once the password is given

  const data = access.data
  const mode = draft.mode ?? data?.mode
  const url = draft.url ?? data?.publicUrl ?? ''
  const changed = {
    ...(draft.mode !== undefined && draft.mode !== data?.mode ? { mode: draft.mode } : {}),
    ...(draft.url !== undefined && draft.url.trim() !== (data?.publicUrl ?? '') ? { publicUrl: draft.url.trim() } : {}),
  }
  const dirty = Object.keys(changed).length > 0

  const review = () => {
    const problem = 'publicUrl' in changed ? publicUrlProblem(changed.publicUrl) : null
    setUrlError(problem)
    if (!problem) setAsking(changed)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Globe className="size-4" aria-hidden="true" />Public access</CardTitle>
        <CardDescription>
          Choose who can reach Shipdok from outside your network, and the address people use to reach it. Shipdok does not set up your proxy or tunnel:
          you provide the address, and Shipdok decides what an outside visitor may see.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {access.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {access.isError && <LoadError error={access.error} title="Could not load the public access settings" onRetry={() => access.refetch()} />}
        {data && (
          <>
            <p className="text-sm text-muted-foreground">{data.visitor === 'outside' ? 'You are connecting from outside your network.' : 'You are on your local network.'}</p>
            <div role="radiogroup" aria-label="Who can reach Shipdok from outside" className="space-y-2">
              {MODES.map((m) => (
                <label key={m.value} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70">
                  <input type="radio" name="public-mode" value={m.value} checked={mode === m.value} disabled={data.modeLocked} onChange={() => setDraft((d) => ({ ...d, mode: m.value }))} className="mt-1" />
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">{m.title}</span>
                    <span className="block text-xs text-muted-foreground">{m.text}</span>
                  </span>
                </label>
              ))}
            </div>
            {data.modeLocked && <p className="text-xs text-muted-foreground">The mode is set by the server's environment (SHIPDOK_PUBLIC) and cannot be changed here.</p>}
            {mode === 'full' && <p className="text-sm text-warning">Anyone on the internet can reach the login page. Keep your password long and unique, and keep your recovery codes safe.</p>}
            {data.visitor === 'outside' && mode !== 'full' && <p className="text-sm text-warning">You are connecting from outside, so this would lock you out of this connection. You would have to open Shipdok from your local network to change it back.</p>}

            <div className="space-y-2">
              <Label htmlFor="pa-url">Public address</Label>
              <Input id="pa-url" placeholder="https://shipdok.example.com" value={url} disabled={data.urlLocked} onChange={(e) => { setDraft((d) => ({ ...d, url: e.target.value })); setUrlError(null) }} spellCheck={false} autoComplete="off" />
              {urlError && <p role="alert" className="text-xs text-destructive">{urlError}</p>}
              {data.urlLocked && <p className="text-xs text-muted-foreground">The address is set by the server's environment (PUBLIC_URL) and cannot be changed here.</p>}
              <p className="text-xs text-muted-foreground">The address your proxy or tunnel gives Shipdok. It is needed to connect GitHub, and it is added to the addresses the dashboard accepts. Leave it empty if you do not use one.</p>
              {webhookUrl(data.publicUrl) && (
                <p className="text-xs text-muted-foreground">GitHub should send webhooks to <code className="rounded bg-muted px-1 py-0.5">{webhookUrl(data.publicUrl)}</code></p>
              )}
            </div>
            <Button disabled={!dirty} onClick={review}>Save changes</Button>
          </>
        )}
        {asking && <ConfirmDialog body={asking} onClose={() => setAsking(null)} onSaved={() => { setAsking(null); setDraft({}) }} />}
      </CardContent>
    </Card>
  )
}
