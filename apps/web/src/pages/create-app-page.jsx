import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api'
import { useGithub, useRepoCheck, useRepos } from '@/lib/queries'
import { githubAppBody, startingApp } from '@/lib/github-apps'
import { DEFAULT_METHOD } from '@/lib/build-methods'
import { clearDraft, loadDraft, saveDraft } from '@/lib/create-draft'
import { useDebounced } from '@/lib/use-debounced'
import { RepoStep } from '@/components/create/repo-step'
import { MethodStep } from '@/components/create/method-step'
import { DetailsStep } from '@/components/create/details-step'
import { ListSkeleton } from '@/components/states'

const num = (v) => (v === '' ? undefined : Number(v))

const STEPS = [
  { title: 'Repository', text: 'Choose the repository. Shipdok checks that it can see it before going on.' },
  { title: 'Build method', text: 'Choose where the app is in the repository and how Shipdok should build it.' },
  { title: 'Details', text: 'The last details. Creating the app does not build it: you press Deploy when you are ready.' },
]

export default function CreateAppPage() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const github = useGithub()
  const apps = github.data?.apps ?? []
  const draft = useMemo(() => loadDraft(), []) // what was chosen before the person left for GitHub (connecting an app) and came back
  const [step, setStep] = useState(1)
  const [chosenApp, setChosenApp] = useState(draft?.githubApp) // undefined = not chosen yet, '' = none, otherwise an app's id
  // The GitHub app in use: the person's choice (if that app still exists), else the only one connected, else none when there are none at all.
  // Until the list of apps is known nothing is decided, so nothing is checked against a guess.
  const githubApp = github.isPending ? undefined
    : chosenApp !== undefined && (chosenApp === '' || apps.some((a) => a.id === chosenApp)) ? chosenApp
      : apps.length === 0 ? '' : startingApp(apps)
  const repos = useRepos(githubApp)
  const [f, setF] = useState({
    repo: draft?.repo ?? '', name: '', branch: 'main', root_dir: '.', container_port: '3000', host_port: '', health_path: '',
    memory_mb: '512', cpus: '1', max_restarts: '5', build_timeout_minutes: '', keep_previous_images: '1', auto_prune: true,
    build_method: DEFAULT_METHOD, install_command: '', build_command: '', start_command: '',
  })
  const [nameTouched, setNameTouched] = useState(false)
  const [branchTouched, setBranchTouched] = useState(false) // once the branch is chosen by hand, the repository's default no longer replaces it
  const [nonce, setNonce] = useState(0) // "check again"
  const set = (patch) => setF((old) => ({ ...old, ...patch }))

  // The repository is checked once it has stopped changing for a moment (not on every key while it is typed).
  const repoText = f.repo.trim()
  const settledRepo = useDebounced(repoText, 400)
  const settled = settledRepo === repoText
  const check = useRepoCheck(settledRepo, githubApp, nonce)

  useEffect(() => { saveDraft({ repo: repoText, githubApp: chosenApp }) }, [repoText, chosenApp])

  // Picking (or typing) a repository from the GitHub App's list fills in a name and the repository's own default branch; the folder starts over.
  const onRepo = (repo) => {
    const known = repos.data?.repos.find((r) => r.fullName === repo)
    setBranchTouched(false)
    set({
      repo, root_dir: '.',
      ...(nameTouched ? {} : { name: repo.split('/')[1] ?? '' }),
      ...(known?.defaultBranch ? { branch: known.defaultBranch } : {}),
    })
  }

  // The check already knows the repository's default branch, so the form can start on it before the branch list is loaded.
  const goToMethod = () => {
    set({ ...(!branchTouched && check.data.defaultBranch ? { branch: check.data.defaultBranch } : {}), ...(nameTouched ? {} : { name: repoText.split('/')[1] ?? '' }) })
    setStep(2)
  }

  const create = useMutation({
    mutationFn: () => api('/apps', {
      method: 'POST',
      body: {
        name: f.name.trim(), repo: f.repo.trim(), branch: f.branch.trim() || undefined, root_dir: f.root_dir.trim() || undefined,
        container_port: num(f.container_port), host_port: num(f.host_port),
        ...(f.health_path.trim() ? { health_path: f.health_path.trim() } : {}),
        memory_mb: num(f.memory_mb), cpus: num(f.cpus), max_restarts: num(f.max_restarts),
        keep_previous_images: num(f.keep_previous_images), auto_prune: f.auto_prune,
        ...(f.build_timeout_minutes.trim() ? { build_timeout_minutes: num(f.build_timeout_minutes.trim()) } : {}),
        build_method: f.build_method,
        ...(f.build_method === 'railpack' ? Object.fromEntries(['install_command', 'build_command', 'start_command'].filter((k) => f[k].trim()).map((k) => [k, f[k].trim()])) : {}),
        ...githubAppBody(apps, githubApp),
      },
    }),
    onSuccess: (app) => {
      clearDraft()
      client.invalidateQueries({ queryKey: ['apps'] })
      toast.success(`${app.name} created`, { description: 'It is not deployed yet: press Deploy when you are ready.' })
      if (app.warning) toast.warning(app.warning, { duration: 12_000 })
      navigate(`/apps/${app.id}`)
    },
  })

  const current = STEPS[step - 1]
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />All apps</Link>
      <Card>
        <CardHeader>
          <CardTitle>New app</CardTitle>
          <p className="text-sm font-medium text-primary" aria-live="polite">Step {step} of {STEPS.length}: {current.title}</p>
          <CardDescription>{current.text}</CardDescription>
        </CardHeader>
        <CardContent>
          {step === 1 && (github.isPending ? <ListSkeleton rows={2} /> : (
            <RepoStep
              apps={apps} githubApp={githubApp} onApp={setChosenApp} repo={f.repo} onRepo={onRepo} repos={repos}
              settled={settled} check={check} onCheckAgain={() => setNonce((n) => n + 1)} onContinue={goToMethod}
            />
          ))}
          {step === 2 && (
            <MethodStep
              repo={repoText} rootDir={f.root_dir} onRootDir={(dir) => set({ root_dir: dir })}
              method={f.build_method} onMethod={(id) => set({ build_method: id })}
              onChangeRepo={() => setStep(1)} onBack={() => setStep(1)} onContinue={() => setStep(3)}
            />
          )}
          {step === 3 && (
            <DetailsStep
              f={f} set={set} setNameTouched={setNameTouched} branchTouched={branchTouched} setBranchTouched={setBranchTouched} githubApp={githubApp}
              mutation={create} canCreate={!(apps.length > 1 && githubApp === undefined)}
              onChangeRepo={() => setStep(1)} onChangeMethod={() => setStep(2)} onBack={() => setStep(2)} onSubmit={() => create.mutate()}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
