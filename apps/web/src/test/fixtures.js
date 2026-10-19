const ID = '11111111-1111-4111-8111-111111111111'

export const makeApp = (over = {}) => ({
  id: ID, name: 'My App', slug: 'my-app', repo: 'owner/my-app', branch: 'main', root_dir: '.', container_port: 3000, host_port: 8080,
  health_path: '/health', memory_mb: 512, cpus: '1.00', desired_state: 'running', max_restarts: 5, keep_previous_images: 1, auto_prune: false,
  latest_deployment: { id: 'd1', status: 'successful', commit_sha: 'a'.repeat(40), queued_at: '2026-10-19T11:50:00Z', finished_at: '2026-10-19T11:51:00Z' },
  runtime: { state: 'running', last_action: 'deploy', last_error: null, last_exit_code: null, oom_killed: false, health_failures: 0, next_restart_at: null, updated_at: '2026-10-19T11:51:05Z' },
  cleanup: null, running_settings: null, settings_pending: null,
  ...over,
})

export const makeDeployment = (over = {}) => ({
  id: 'dep-1', app_id: ID, commit_sha: 'b'.repeat(40), trigger: 'manual', status: 'successful', image_ref: 'shipdok/my-app:dep-1',
  error_summary: null, queued_at: '2026-10-19T11:50:00Z', started_at: '2026-10-19T11:50:02Z', finished_at: '2026-10-19T11:51:00Z',
  ...over,
})

export const APP_ID = ID
export const line = (n, stream = 'stdout', text = `line ${n}`) => `2026-10-19T12:00:${String(n).padStart(2, '0')}.000Z ${stream} ${text}\n`

export const makeVersion = (over = {}) => ({
  deploymentId: 'dep-1', commit: 'b'.repeat(40), trigger: 'manual', finishedAt: '2026-10-19T11:51:00Z', image: 'shipdok/my-app:dep-1', bytes: 50_000_000,
  state: 'live', rollbackOf: null, canRollBackTo: false, ...over,
})

export const makeImages = (versions = [makeVersion()], over = {}) => ({
  keep_previous_images: 1, auto_prune: false, cleanup: null,
  prunableBytes: versions.filter((v) => v.state === 'prunable').reduce((a, v) => a + (v.bytes ?? 0), 0), versions, ...over,
})
