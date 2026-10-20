import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { GithubAppSelect } from '@/components/github-app-select'
import { api } from '@/lib/api'
import { useGithub } from '@/lib/queries'

/**
 * Which connected GitHub app this project uses. It is read when a deployment starts and when a push arrives, so a change applies at once
 * (it is not one of the settings that wait for the next deployment). The repository itself cannot be changed.
 */
export function GithubAppSetting({ app }) {
  const client = useQueryClient()
  const github = useGithub()
  const apps = github.data?.apps ?? []
  const saved = app.github_app_id ?? ''
  const [draft, setDraft] = useState(null) // null: untouched
  const value = draft ?? saved
  const save = useMutation({
    mutationFn: () => api(`/apps/${app.id}`, { method: 'PUT', body: { github_app_id: value || null } }),
    onSuccess: (updated) => {
      client.setQueryData(['app', app.id], updated)
      client.invalidateQueries({ queryKey: ['apps'] })
      client.invalidateQueries({ queryKey: ['github'] }) // the lists of projects under each GitHub app
      client.invalidateQueries({ queryKey: ['branches'] })
      setDraft(null)
      toast.success('GitHub app saved')
      if (updated.warning) toast.warning(updated.warning, { duration: 12_000 })
    },
    onError: (err) => toast.error(err.message),
  })
  if (github.isPending) return null
  if (github.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">GitHub app</CardTitle>
          <CardDescription>Could not load the connected GitHub apps. <button type="button" className="underline" onClick={() => github.refetch()}>Try again</button></CardDescription>
        </CardHeader>
      </Card>
    )
  }
  if (apps.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">GitHub app</CardTitle>
          <CardDescription>No GitHub app is connected. A public repository still deploys by hand; a private one, and deployments on every push, need a GitHub app: <Link to="/github" className="underline">connect one</Link>.</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">GitHub app</CardTitle>
        <CardDescription>
          The connected GitHub app that has this repository: it clones a private repository and its pushes deploy this app. A change applies at once;
          Shipdok then checks whether the new app is installed on the repository. Apps are connected on the <Link to="/github" className="underline">GitHub page</Link>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (value !== saved && !save.isPending) save.mutate() }}>
          <div className="space-y-1.5">
            <Label htmlFor="s-github-app">GitHub app</Label>
            <GithubAppSelect id="s-github-app" value={value} onChange={setDraft} apps={apps} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={draft === null || save.isPending} onClick={() => setDraft(null)}>Discard</Button>
            <Button type="submit" disabled={value === saved || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
