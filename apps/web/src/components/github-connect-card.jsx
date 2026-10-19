import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Plug } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { usePublicAccess } from '@/lib/queries'
import { connectProblem, postManifest } from '@/lib/githubconnect'

/** The button: Shipdok has GitHub create the app, the administrator confirms once on github.com, and GitHub sends the browser back. */
export function GithubConnectCard() {
  const access = usePublicAccess()
  const [kind, setKind] = useState('personal')
  const [org, setOrg] = useState('')
  const [name, setName] = useState('')
  const [problem, setProblem] = useState(null)
  const start = useMutation({
    mutationFn: () => api('/github/connect/start', {
      method: 'POST',
      body: { ...(kind === 'org' ? { owner: org.trim() } : {}), ...(name.trim() ? { name: name.trim() } : {}) },
    }),
    onSuccess: (data) => postManifest(data),
  })
  const submit = (e) => {
    e.preventDefault()
    const p = connectProblem({ kind, org, name })
    setProblem(p)
    if (!p && !start.isPending) start.mutate()
  }
  const error = problem ?? start.error?.message
  const noAddress = access.data && !access.data.publicUrl
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Plug className="size-4" aria-hidden="true" />Connect GitHub</CardTitle>
        <CardDescription>
          Shipdok has GitHub create a private app for you. Confirm once on GitHub, and Shipdok keeps the app's key and webhook secret, encrypted. The app gets
          read access to code and metadata, and hears about pushes. Nothing else. Afterwards you choose which repositories it may see.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div role="radiogroup" aria-label="Where to create the app" className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="gh-owner" checked={kind === 'personal'} onChange={() => setKind('personal')} />My personal account
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="gh-owner" checked={kind === 'org'} onChange={() => setKind('org')} />An organisation
            </label>
          </div>
          {kind === 'org' && (
            <div className="space-y-2">
              <Label htmlFor="gh-org">Organisation name</Label>
              <Input id="gh-org" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="my-organisation" autoComplete="off" spellCheck={false} />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="gh-name">App name</Label>
            <Input id="gh-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shipdok-xxxx (picked for you)" autoComplete="off" />
            <p className="text-xs text-muted-foreground">GitHub app names are unique across GitHub. You can change the name on the next screen.</p>
          </div>
          {noAddress && (
            <p className="text-sm text-warning">
              No public address is set, so GitHub cannot deliver pushes yet. You can connect now and set it later under{' '}
              <Link to="/security" className="underline">Public access</Link>: Shipdok then updates the app for you.
            </p>
          )}
          <p className="text-xs text-muted-foreground">You leave this page for github.com and GitHub brings you back here when you are done.</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={start.isPending}>{start.isPending ? 'Please wait…' : 'Connect GitHub'}</Button>
        </form>
      </CardContent>
    </Card>
  )
}
