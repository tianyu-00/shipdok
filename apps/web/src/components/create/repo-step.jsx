import { Link } from 'react-router-dom'
import { CircleCheck, ExternalLink, Loader2, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/field'
import { GithubAppSelect } from '@/components/github-app-select'
import { RepoPicker } from '@/components/repo-picker'
import { appLabel } from '@/lib/github-apps'
import { installUrl } from '@/lib/githubconnect'
import { isRepoName } from '@/lib/branches'

const InstallLink = ({ app }) => {
  const url = app ? installUrl(app.slug) : null
  return url ? <Button variant="outline" size="sm" asChild><a href={url} target="_blank" rel="noreferrer">Install on repositories<ExternalLink className="size-4" aria-hidden="true" /></a></Button> : null
}
const ConnectLink = () => <Button variant="outline" size="sm" asChild><Link to="/github">Connect a GitHub app</Link></Button>

/** What the check said, in words, with the way forward. */
function Status({ apps, githubApp, repo, settled, check, onCheckAgain }) {
  const app = apps.find((a) => a.id === githubApp)
  if (!repo.trim()) return null
  if (!isRepoName(repo)) return <p className="text-sm text-muted-foreground">Type the repository as owner/name, or paste its GitHub link.</p>
  if (githubApp === undefined) return <p className="text-sm text-muted-foreground">Choose a GitHub app (or None) first.</p>
  if (!settled || check.isPending) {
    return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />Checking the repository…</p>
  }
  const again = <Button variant="outline" size="sm" onClick={onCheckAgain}>Check again</Button>
  if (check.isError) {
    return (
      <Alert variant="destructive" role="alert"><TriangleAlert className="size-4" />
        <AlertDescription className="space-y-2"><p>Could not check the repository: {check.error.message}</p>{again}</AlertDescription>
      </Alert>
    )
  }
  const d = check.data
  if (!d.accessible) {
    return (
      <Alert role="alert" className="border-warning/50"><TriangleAlert className="size-4 text-warning" />
        <AlertDescription className="space-y-2">
          {d.reason === 'rate_limited' && <p>GitHub is limiting requests right now. Wait a few minutes and check again. (A GitHub app raises the limit.)</p>}
          {d.reason === 'unreachable' && <p>Shipdok could not reach GitHub. Check again in a moment.</p>}
          {d.reason === 'not_found' && !d.appChosen && (
            <>
              <p>Shipdok cannot see <strong>{repo}</strong>. It may not exist, or it may be private. For a private repository, {apps.length > 0 ? 'choose a GitHub app that is installed on it above, or connect another' : 'connect a GitHub app and install it on the repository'}.</p>
              <p className="text-muted-foreground">What you have chosen here is remembered while you do that.</p>
            </>
          )}
          {d.reason === 'not_found' && d.appChosen && (
            <p>Shipdok cannot see <strong>{repo}</strong> through {app ? appLabel(app) : 'that GitHub app'}. Either it does not exist, or the app is not installed on it. Install the app on the repository (on GitHub), then check again.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {d.reason === 'not_found' && d.appChosen && <InstallLink app={app} />}
            {d.reason === 'not_found' && !d.appChosen && <ConnectLink />}
            {again}
          </div>
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <div className="space-y-2">
      <p role="status" className="flex flex-wrap items-center gap-2 text-sm">
        <CircleCheck className="size-4 text-success" aria-hidden="true" />
        <span>Found <strong>{d.fullName}</strong> ({d.private ? 'private' : 'public'}{d.defaultBranch ? `, default branch ${d.defaultBranch}` : ''}).</span>
      </p>
      {d.via === 'anonymous' && !d.appChosen && (
        <Alert className="border-primary/40"><AlertDescription className="space-y-2">
          <p>This repository is public, so Shipdok can build it. Without a GitHub app, pushes to it do <strong>not</strong> deploy it automatically: you press Deploy yourself. Connect a GitHub app to deploy on every push.</p>
          <ConnectLink />
        </AlertDescription></Alert>
      )}
      {d.via === 'anonymous' && d.appChosen && (
        <Alert className="border-primary/40"><AlertDescription className="space-y-2">
          <p>{app ? appLabel(app) : 'The GitHub app'} is not installed on this repository. Shipdok can still read it because it is public, but pushes will not deploy it automatically. Install the app on the repository to deploy on every push.</p>
          <InstallLink app={app} />
        </AlertDescription></Alert>
      )}
    </div>
  )
}

/** Step 1: which GitHub app can see the repository, and which repository. Nothing moves on until Shipdok has checked it can see it. */
export function RepoStep({ apps, githubApp, onApp, repo, onRepo, repos, settled, check, onCheckAgain, onContinue }) {
  const ready = settled && check.data?.accessible === true && githubApp !== undefined
  return (
    <div className="space-y-5">
      {apps.length > 0 ? (
        <Field id="github_app" label="GitHub app" hint="The connected GitHub app that can see the repository: it lists your repositories and clones a private one. Choose None for a public repository.">
          <GithubAppSelect id="github_app" value={githubApp} onChange={onApp} apps={apps} choose={apps.length > 1} />
        </Field>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">No GitHub app is connected, so only public repositories can be used. To use a private repository, connect a GitHub app first.</p>
          <ConnectLink />
        </div>
      )}
      <Field id="repo" label="GitHub repository" hint={repos.data?.available ? 'The repositories the chosen GitHub app can see. For any other public repository, type owner/repo or paste its GitHub link.' : 'owner/repo, or paste the repository\'s GitHub link.'}>
        <RepoPicker id="repo" value={repo} onChange={onRepo} repos={repos} githubAppId={githubApp} />
      </Field>
      <Status apps={apps} githubApp={githubApp} repo={repo.trim()} settled={settled} check={check} onCheckAgain={onCheckAgain} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" asChild><Link to="/">Cancel</Link></Button>
        <Button type="button" disabled={!ready} onClick={onContinue}>Continue</Button>
      </div>
    </div>
  )
}
