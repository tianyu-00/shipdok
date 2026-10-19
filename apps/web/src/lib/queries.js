// Every read the dashboard does, as a query, so screens stay small and the polling rules live in one place.
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { isActiveDeployment } from '@/lib/format'

export const authQuery = { queryKey: ['auth'], queryFn: async () => {
  const status = await api('/auth/status')
  if (!status.authenticated) return { ...status, username: null }
  const me = await api('/auth/me')
  return { ...status, username: me.username }
}, retry: false, staleTime: 60_000 }

export const useAuth = () => useQuery(authQuery)

export const useApps = () => useQuery({ queryKey: ['apps'], queryFn: () => api('/apps'), refetchInterval: 5000 })

export const useApp = (id) => useQuery({ queryKey: ['app', id], queryFn: () => api(`/apps/${id}`), refetchInterval: 4000 })

// Faster while something is being built, slower when everything is quiet.
export const useDeployments = (id) => useQuery({
  queryKey: ['deployments', id],
  queryFn: () => api(`/apps/${id}/deployments`),
  refetchInterval: (q) => (q.state.data?.some((d) => isActiveDeployment(d.status)) ? 2000 : 10_000),
})

export const useCrashes = (id) => useQuery({ queryKey: ['crashes', id], queryFn: () => api(`/apps/${id}/crashes`), refetchInterval: 15_000 })

// 501 means no GitHub App is configured: that is an answer, not a failure, so the create form falls back to typing the repo.
export const useRepos = () => useQuery({
  queryKey: ['repos'],
  queryFn: async () => {
    try {
      return { available: true, repos: (await api('/github/repos')).repos }
    } catch (err) {
      if (err.status === 501) return { available: false, repos: [] }
      throw err
    }
  },
  staleTime: 60_000,
  retry: false,
})

export const useEnv = (id) => useQuery({ queryKey: ['env', id], queryFn: () => api(`/apps/${id}/env`) })

export const useStorage = () => useQuery({ queryKey: ['storage'], queryFn: () => api('/storage'), refetchInterval: 30_000 })

// The versions that have an image (live / previous / prunable / removed), the retention settings and the last clean-up.
export const useImages = (id) => useQuery({ queryKey: ['images', id], queryFn: () => api(`/apps/${id}/images`), refetchInterval: 6000 })

// The last hour of CPU and memory readings (the worker takes one every 15 seconds).
export const useStats = (id) => useQuery({ queryKey: ['stats', id], queryFn: () => api(`/apps/${id}/stats`), refetchInterval: 15_000 })

// The latest sign-in attempts, good and bad.
export const useLogins = () => useQuery({ queryKey: ['logins'], queryFn: () => api('/auth/logins?limit=50'), refetchInterval: 30_000 })

// How many recovery codes are left (never the codes themselves).
export const useRecovery = () => useQuery({ queryKey: ['recovery'], queryFn: () => api('/auth/recovery') })

// Who may reach Shipdok from outside, and the public address (also tells whether THIS visit counts as local or outside).
export const usePublicAccess = () => useQuery({ queryKey: ['public-access'], queryFn: () => api('/settings/public'), retry: false })
