// Every read the dashboard does, as a query, so screens stay small and the polling rules live in one place.
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { isActiveDeployment } from '@/lib/format'
import { isRepoName } from '@/lib/branches'

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

// An app's persistent storage (volumes mounted, and detached ones whose data is kept), and every volume kept without being mounted.
export const useAppVolumes = (id) => useQuery({ queryKey: ['volumes', id], queryFn: () => api(`/apps/${id}/volumes`), retry: false })
// Whether the sizes of the persistent volumes are being measured (asked for with a button; Docker needs seconds, so it is polled only meanwhile).
export const useVolumeSizing = () => useQuery({ queryKey: ['volume-sizing'], queryFn: () => api('/volumes/sizes'), refetchInterval: (q) => (q.state.data?.measuring ? 2000 : false) })
export const useKeptVolumes = () => useQuery({ queryKey: ['kept-volumes'], queryFn: () => api('/volumes'), refetchInterval: 5000 })

// Docker's build cache: shared by every app. Checked often while a clean-up is waiting or running, rarely otherwise.
export const useBuildCache = () => useQuery({ queryKey: ['build-cache'], queryFn: () => api('/build-cache'), refetchInterval: (q) => (q.state.data?.cleaning ? 3000 : 30_000) })

export const useCrashes = (id) => useQuery({ queryKey: ['crashes', id], queryFn: () => api(`/apps/${id}/crashes`), refetchInterval: 15_000 })

// The repositories one GitHub App can see. No GitHub app chosen: nothing is asked (the form is a plain box). An app that is gone (404) or
// whose credentials cannot be read (409) is an answer, not a failure, so the form falls back to typing the repo.
export const useRepos = (githubAppId) => useQuery({
  queryKey: ['repos', githubAppId ?? null],
  enabled: Boolean(githubAppId),
  queryFn: async () => {
    try {
      return { available: true, repos: (await api(`/github/apps/${githubAppId}/repos`)).repos }
    } catch (err) {
      if (err.status === 404 || err.status === 409) return { available: false, repos: [] }
      throw err
    }
  },
  staleTime: 60_000,
  retry: false,
})

// The branches of a repository (through the chosen GitHub app's installation, or anonymously for a public one). A repository that is not usable,
// or a failed answer, is an error the branch picker turns into a plain text box: typing the name always works.
export const useBranches = (repo, githubAppId) => useQuery({
  queryKey: ['branches', repo, githubAppId ?? null],
  queryFn: () => api(`/github/branches?repo=${encodeURIComponent(repo)}${githubAppId ? `&app=${encodeURIComponent(githubAppId)}` : ''}`),
  enabled: isRepoName(repo),
  staleTime: 60_000,
  retry: false,
  refetchOnWindowFocus: false,
})

// Can Shipdok see this repository (through the chosen GitHub app, or anonymously for a public one), and what is in it? An unusable repository is an
// ordinary answer (accessible: false). `nonce` above 0 skips the server's short memory: the "check again" after installing the app.
export const useRepoCheck = (repo, githubApp, nonce = 0) => useQuery({
  queryKey: ['repo-check', repo, githubApp ?? null, nonce],
  queryFn: () => api(`/github/repo-check?repo=${encodeURIComponent(repo)}${githubApp ? `&app=${encodeURIComponent(githubApp)}` : ''}${nonce > 0 ? '&fresh=1' : ''}`),
  enabled: isRepoName(repo) && githubApp !== undefined,
  staleTime: 60_000,
  retry: false,
  refetchOnWindowFocus: false,
})

export const useEnv = (id) => useQuery({ queryKey: ['env', id], queryFn: () => api(`/apps/${id}/env`) })

export const useOldImages = () => useQuery({ queryKey: ['old-images'], queryFn: () => api('/images'), refetchInterval: 30_000 })
export const useStorage = () => useQuery({ queryKey: ['storage'], queryFn: () => api('/storage'), refetchInterval: 30_000 })

// The versions that have an image (live / previous / prunable / removed), the retention settings and the last clean-up.
export const useImages = (id) => useQuery({ queryKey: ['images', id], queryFn: () => api(`/apps/${id}/images`), refetchInterval: 6000 })

// The last hour of CPU and memory readings (the worker takes one every 15 seconds).
export const useStats = (id) => useQuery({ queryKey: ['stats', id], queryFn: () => api(`/apps/${id}/stats`), refetchInterval: 15_000 })

// Sign-in attempts, good and bad (scope 'signins'), or what was done with the password (scope 'activity'); up to 500, the dashboard pages through them.
export const useLogins = (scope) => useQuery({ queryKey: ['logins', scope], queryFn: () => api(`/auth/logins?limit=500&scope=${scope}`), refetchInterval: 30_000 })

// How many recovery codes are left (never the codes themselves).
export const useRecovery = () => useQuery({ queryKey: ['recovery'], queryFn: () => api('/auth/recovery') })

// Who may reach Shipdok from outside, and the public address (also tells whether THIS visit counts as local or outside).
export const usePublicAccess = () => useQuery({ queryKey: ['public-access'], queryFn: () => api('/settings/public'), retry: false })

// The connected GitHub Apps (`apps`, empty when none), each with its details and the projects assigned to it (never a secret).
// (Read again every 30 seconds: a refused push shows up on its own.)
export const useGithub = () => useQuery({ queryKey: ['github'], queryFn: () => api('/github'), retry: false, refetchInterval: 30_000 })

// Does GitHub send this app's webhooks to the address Shipdok expects?
// (`enabled` false for an app whose credentials cannot be read: GitHub cannot be asked as that app.)
export const useGithubWebhook = (githubAppId, enabled = true) => useQuery({ queryKey: ['github-webhook', githubAppId], queryFn: () => api(`/github/apps/${githubAppId}/webhook`), enabled, retry: false })

// The running version and the newest published one. The API keeps its answer for an hour, so asking on every page load costs nothing.
export const useVersion = () => useQuery({ queryKey: ['version'], queryFn: () => api('/version'), staleTime: 10 * 60_000, retry: false })

// Backups of Shipdok itself: quick while one is waiting or being made, slow otherwise.
export const useBackups = () => useQuery({
  queryKey: ['backups'],
  queryFn: () => api('/backups'),
  refetchInterval: (q) => (((q.state.data?.backups ?? []).some((b) => b.status === 'queued' || b.status === 'running') || (q.state.data?.restores ?? []).some((r) => r.status === 'queued' || r.status === 'running')) ? 3000 : 30_000),
})
