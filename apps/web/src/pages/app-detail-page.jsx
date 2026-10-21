import { useEffect } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink, GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { useApp } from '@/lib/queries'
import { appAddress, displayState } from '@/lib/format'
import { ApiError } from '@/lib/api'
import { runningSetting } from '@/lib/settings'
import { RuntimeBadge } from '@/components/status-badge'
import { LoadError } from '@/components/states'
import { RepoLink } from '@/components/repo-link'
import { DeployButton, ControlButtons } from '@/components/app-actions'
import { NotDeployedNotice } from '@/components/not-deployed-notice'
import OverviewTab from '@/components/overview-tab'
import DeploymentsTab from '@/components/deployments-tab'
import ImagesTab from '@/components/images-tab'
import LogsTab from '@/components/logs-tab'
import VariablesTab from '@/components/variables-tab'
import SettingsTab from '@/components/settings-tab'
import { useDeleteApp } from '@/components/delete-app'

const TABS = ['overview', 'deployments', 'images', 'logs', 'variables', 'settings']

export default function AppDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const app = useApp(id)
  const client = useQueryClient()
  // Remember that this app was being deleted (also set the moment the delete is accepted, see useDeleteApp), so that the
  // "not found" the worker's last step causes can be told apart from a mistyped address.
  useEffect(() => { if (app.data?.deleting_at) client.setQueryData(['deleting', id], true) }, [app.data?.deleting_at, client, id])
  const gone = app.isError && app.error instanceof ApiError && app.error.status === 404 && client.getQueryData(['deleting', id]) === true
  useEffect(() => {
    if (!gone) return
    toast.success('App deleted')
    navigate('/', { replace: true })
  }, [gone, navigate])
  if (gone) return null

  // The tab is the last part of the address, so a refresh or a shared link lands on the same tab.
  const segment = location.pathname.split('/')[3]
  const tab = TABS.includes(segment) ? segment : 'overview'

  if (app.isPending) return <Skeleton className="h-40 w-full" />
  if (app.isError) {
    const notFound = app.error instanceof ApiError && app.error.status === 404
    return (
      <div className="space-y-4">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />All apps</Link>
        <LoadError error={app.error} title={notFound ? 'App not found' : 'Could not load this app'} onRetry={notFound ? undefined : () => app.refetch()} />
      </div>
    )
  }

  const a = app.data
  if (a.deleting_at) return <DeletingPage app={a} />
  return (
    <div className="space-y-6">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />All apps</Link>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold">{a.name}</h1>
            <RuntimeBadge state={displayState(a)} />
            {a.desired_state === 'stopped' && <Badge variant="secondary">Stopped on purpose</Badge>}
          </div>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <RepoLink repo={a.repo} />
            <span className="inline-flex items-center gap-1"><GitBranch className="size-3.5" aria-hidden="true" />{a.branch}</span>
            <a href={appAddress(a)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
              Open :{runningSetting(a, 'host_port')}<ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </p>
        </div>
        <div className="flex flex-wrap gap-2"><DeployButton app={a} /><ControlButtons app={a} /></div>
      </div>

      <NotDeployedNotice app={a} />

      <Tabs value={tab} onValueChange={(t) => navigate(t === 'overview' ? `/apps/${id}` : `/apps/${id}/${t}`)}>
        <div className="-mx-1 overflow-x-auto px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsList className="w-max">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="deployments">Deployments</TabsTrigger>
            <TabsTrigger value="images">Images</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="variables">Variables</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview"><OverviewTab app={a} /></TabsContent>
        <TabsContent value="deployments"><DeploymentsTab app={a} /></TabsContent>
        <TabsContent value="images"><ImagesTab app={a} /></TabsContent>
        <TabsContent value="logs"><LogsTab app={a} /></TabsContent>
        <TabsContent value="variables"><VariablesTab app={a} /></TabsContent>
        <TabsContent value="settings"><SettingsTab app={a} /></TabsContent>
      </Tabs>
    </div>
  )
}

// While the worker removes an app (or after it failed) nothing else can be done with it.
function DeletingPage({ app }) {
  const retry = useDeleteApp(app)
  return (
    <div className="space-y-6">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />All apps</Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="truncate text-2xl font-semibold">{app.name}</h1>
        <RuntimeBadge state={displayState(app)} />
      </div>
      {app.delete_error ? (
        <Alert variant="destructive">
          <AlertTitle>The app could not be deleted</AlertTitle>
          <AlertDescription>
            <p>{app.delete_error}</p>
            <p className="mt-1">Parts of it may already be removed. Fix the cause if you can, then try again: what is already gone is skipped and the rest is removed.</p>
            <Button className="mt-3" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertTitle>This app is being deleted</AlertTitle>
          <AlertDescription>Its container, images, logs and records are being removed. This page closes by itself when it is done.</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
