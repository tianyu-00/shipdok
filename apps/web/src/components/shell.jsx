import { Link } from 'react-router-dom'
import { HardDrive, LogOut, Ship, ShieldCheck } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { usePublicAccess } from '@/lib/queries'
import { ThemeToggle } from '@/components/theme-toggle'
import { forgetSession } from '@/lib/session'

export function Shell({ username, children }) {
  const client = useQueryClient()
  const access = usePublicAccess()
  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    // Whatever the answer, this browser should stop showing the data.
    onSettled: () => forgetSession(client),
  })
  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold"><Ship className="size-5 text-primary" aria-hidden="true" />Shipdok</Link>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild><Link to="/storage" aria-label="Storage"><HardDrive className="size-4" aria-hidden="true" /><span className="hidden sm:inline">Storage</span></Link></Button>
            <Button variant="ghost" size="sm" asChild><Link to="/security" aria-label="Security"><ShieldCheck className="size-4" aria-hidden="true" /><span className="hidden sm:inline">Security</span></Link></Button>
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
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}
