import { Link } from 'react-router-dom'
import { LogOut, Ship } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { ThemeToggle } from '@/components/theme-toggle'

export function Shell({ username, children }) {
  const client = useQueryClient()
  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    // Whatever the answer, this browser should stop showing the data.
    onSettled: () => {
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
      client.setQueryData(['auth'], (old) => ({ ...(old ?? {}), authenticated: false, username: null }))
    },
  })
  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold"><Ship className="size-5 text-primary" aria-hidden="true" />Shipdok</Link>
          <div className="ml-auto flex items-center gap-1">
            <span className="mr-2 hidden text-sm text-muted-foreground sm:inline">{username}</span>
            <ThemeToggle />
            <Button variant="ghost" size="icon" aria-label="Log out" onClick={() => logout.mutate()}><LogOut className="size-4" /></Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}
