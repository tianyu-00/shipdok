import { useState } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LogViewer } from '@/components/log-viewer'

// The app's own output. "Previous run" is what the container printed before it was last restarted or replaced
// (the place to look after a crash).
export default function LogsTab({ app }) {
  const [which, setWhich] = useState('runtime')
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          What {app.name} prints. It starts over whenever the app restarts or a new version is deployed; the run before is kept.
        </p>
        <Tabs value={which} onValueChange={setWhich}>
          <TabsList>
            <TabsTrigger value="runtime">Current run</TabsTrigger>
            <TabsTrigger value="previous">Previous run</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <LogViewer
        key={which}
        path={`/apps/${app.id}/logs`}
        kind={which}
        title={which === 'previous' ? 'Previous run' : 'Current run'}
        filename={`${app.slug ?? 'app'}-${which}.log`}
        emptyText={which === 'previous' ? 'There is no earlier run.' : 'The app has not printed anything yet.'}
      />
    </div>
  )
}
