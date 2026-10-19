import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { manualProblem } from '@/lib/githubconnect'

/** For someone who already has a GitHub App: enter its ID, private key and webhook secret. Shipdok checks them with GitHub first. */
export function GithubManualCard() {
  const client = useQueryClient()
  const [f, setF] = useState({ appId: '', privateKey: '', webhookSecret: '', password: '' })
  const [problem, setProblem] = useState(null)
  const set = (k) => (e) => setF((old) => ({ ...old, [k]: e.target.value }))
  const connect = useMutation({
    mutationFn: () => api('/github/manual', { method: 'POST', body: { password: f.password, appId: f.appId.trim(), privateKey: f.privateKey, webhookSecret: f.webhookSecret } }),
    onSuccess: () => {
      setF({ appId: '', privateKey: '', webhookSecret: '', password: '' }) // the secrets are not kept in the page
      toast.success('GitHub connected')
      client.invalidateQueries({ queryKey: ['github'] })
      client.invalidateQueries({ queryKey: ['logins'] })
      client.invalidateQueries({ queryKey: ['repos'] })
    },
  })
  const submit = (e) => {
    e.preventDefault()
    const p = manualProblem(f)
    setProblem(p)
    if (!p && !connect.isPending) connect.mutate()
  }
  const error = problem ?? connect.error?.message
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" aria-hidden="true" />I already have a GitHub App</CardTitle>
        <CardDescription>
          Enter the app's details from its settings page on GitHub: the App ID, a private key you generated there (the .pem file), and the webhook secret you
          set. Shipdok checks them with GitHub before saving anything, and stores them encrypted. They are never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate autoComplete="off">
          <div className="space-y-2">
            <Label htmlFor="gh-appid">App ID</Label>
            <Input id="gh-appid" inputMode="numeric" value={f.appId} onChange={set('appId')} autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gh-key">Private key</Label>
            <Textarea id="gh-key" rows={5} value={f.privateKey} onChange={set('privateKey')} placeholder={'-----BEGIN RSA PRIVATE KEY-----\n...'} spellCheck={false} autoComplete="off" className="font-mono text-xs" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gh-secret">Webhook secret</Label>
            <Input id="gh-secret" type="password" value={f.webhookSecret} onChange={set('webhookSecret')} autoComplete="new-password" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gh-password">Current password</Label>
            <Input id="gh-password" type="password" value={f.password} onChange={set('password')} autoComplete="current-password" />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={connect.isPending}>{connect.isPending ? 'Checking with GitHub…' : 'Connect'}</Button>
        </form>
      </CardContent>
    </Card>
  )
}
