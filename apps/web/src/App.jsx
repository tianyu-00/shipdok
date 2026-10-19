import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setUnauthorizedHandler } from '@/lib/api'
import { useAuth } from '@/lib/queries'
import { Shell } from '@/components/shell'
import { LoadError } from '@/components/states'
import AuthPage from '@/pages/auth-page'
import AppsPage from '@/pages/apps-page'
import CreateAppPage from '@/pages/create-app-page'
import AppDetailPage from '@/pages/app-detail-page'

export default function App() {
  const client = useQueryClient()
  const auth = useAuth()

  // A request that was refused because the session ran out: forget everything and show the login page.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
      client.setQueryData(['auth'], (old) => ({ ...(old ?? {}), authenticated: false, username: null, expired: true }))
    })
    return () => setUnauthorizedHandler(null)
  }, [client])

  let content
  if (auth.isPending) {
    content = <p className="p-8 text-center text-sm text-muted-foreground" role="status">Loading…</p>
  } else if (auth.isError) {
    content = <div className="mx-auto max-w-md p-6"><LoadError error={auth.error} title="Cannot reach Shipdok" onRetry={() => auth.refetch()} /></div>
  } else if (auth.data.needsSetup || !auth.data.authenticated) {
    content = <AuthPage status={auth.data} />
  } else {
    content = (
      <Shell username={auth.data.username}>
        <Routes>
          <Route path="/" element={<AppsPage />} />
          <Route path="/apps/new" element={<CreateAppPage />} />
          <Route path="/apps/:id/*" element={<AppDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    )
  }

  return (
    <TooltipProvider delayDuration={200}>
      {content}
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
