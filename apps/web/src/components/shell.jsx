import { Link } from 'react-router-dom'
import { BookOpen, GitBranch, HardDrive, LogOut, Ship, ShieldCheck } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { usePublicAccess, useRecovery } from '@/lib/queries'
import { ThemeToggle } from '@/components/theme-toggle'
import { forgetSession } from '@/lib/session'
import { VersionIndicator } from '@/components/version-indicator'

export function Shell({ username, children }) {
  const client = useQueryClient()
  const access = usePublicAccess()
  const recovery = useRecovery()
  const codesLeft = recovery.data?.remaining
  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    // Whatever the answer, this browser should stop showing the data.
    onSettled: () => forgetSession(client),
  })
  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-2 sm:gap-4 sm:px-4">
          <div className="flex shrink-0 flex-col items-start sm:flex-row sm:items-center sm:gap-2">
            <Link to="/" className="flex items-center gap-2 font-semibold"><Ship className="size-5 text-primary" aria-hidden="true" />Shipdok</Link>
            <VersionIndicator />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
            <Button variant="ghost" size="sm" className="px-2 has-[>svg]:px-1.5 sm:px-3 sm:has-[>svg]:px-2.5" asChild><Link to="/storage" aria-label="Storage"><HardDrive className="size-4" aria-hidden="true" /><span className="hidden sm:inline">Storage</span></Link></Button>
            <Button variant="ghost" size="sm" className="px-2 has-[>svg]:px-1.5 sm:px-3 sm:has-[>svg]:px-2.5" asChild><Link to="/github" aria-label="GitHub"><GitBranch className="size-4" aria-hidden="true" /><span className="hidden sm:inline">GitHub</span></Link></Button>
            <Button variant="ghost" size="sm" className="px-2 has-[>svg]:px-1.5 sm:px-3 sm:has-[>svg]:px-2.5" asChild><Link to="/security" aria-label="Security"><ShieldCheck className="size-4" aria-hidden="true" /><span className="hidden sm:inline">Security</span></Link></Button>
            <Button variant="ghost" size="sm" className="hidden sm:inline-flex" asChild><a href="/api/docs" target="_blank" rel="noopener noreferrer" aria-label="API"><BookOpen className="size-4" aria-hidden="true" /><span className="hidden sm:inline">API</span></a></Button>
            <span className="mr-2 hidden text-sm text-muted-foreground sm:inline">{username}</span>
            <ThemeToggle />
            <Button variant="ghost" size="icon" aria-label="Log out" onClick={() => logout.mutate()}><LogOut className="size-4" /></Button>
          </div>
        </div>
      </header>
      {access.data?.mode === 'full' && (
        <div role="status" aria-label="Public access" className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-center text-sm text-warning">
          The whole dashboard is reachable from the internet. <Link to="/security" className="underline">Security settings</Link>
        </div>
      )}
      {typeof codesLeft === 'number' && codesLeft <= 3 && (
        <div role="status" aria-label="Recovery codes" className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-center text-sm text-warning">
          {codesLeft === 0 ? 'You have no recovery codes left.' : `You have ${codesLeft} recovery ${codesLeft === 1 ? 'code' : 'codes'} left.`}{' '}
          If you forget your password they are the way back in. <Link to="/security" className="underline">Make new codes</Link>
        </div>
      )}
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}
