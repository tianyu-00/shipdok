import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Routes, Route } from 'react-router-dom'
import AppDetailPage from './app-detail-page'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { makeApp, makeDeployment, APP_ID } from '@/test/fixtures'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const page = (route = `/apps/${APP_ID}`) => renderWithProviders(<Routes><Route path="/apps/:id/*" element={<AppDetailPage />} /><Route path="/" element={<p>home</p>} /></Routes>, { route })
const base = (over = {}) => ({
  [`GET /api/apps/${APP_ID}`]: makeApp(),
  [`GET /api/apps/${APP_ID}/deployments`]: [makeDeployment()],
  [`GET /api/apps/${APP_ID}/crashes`]: [],
  [`GET /api/apps/${APP_ID}/stats`]: { latest: null, samples: [] },
  [`GET /api/apps/${APP_ID}/env`]: { variables: [], pending: { pending: false } },
  [`GET /api/apps/${APP_ID}/logs`]: { text: '', offset: 0, nextOffset: 0, size: 0, complete: false, truncated: false },
  ...over,
})

describe('the app page', () => {
  test('shows the name, repository, branch, runtime state and the link to the running app', async () => {
    mockApi(base())
    page()
    expect(await screen.findByRole('heading', { name: 'My App' })).toBeInTheDocument()
    expect(screen.getByText('owner/my-app')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open :8080/i })).toHaveAttribute('href', `http://${window.location.hostname}:8080`)
  })

  test('while a Stop is on its way the header says "Stopping…"', async () => {
    mockApi(base({ [`GET /api/apps/${APP_ID}`]: makeApp({ desired_state: 'stopped', runtime: { state: 'running' } }) }))
    page()
    expect(await screen.findByText('Stopping…')).toBeInTheDocument()
    expect(screen.getByText('Stopped on purpose')).toBeInTheDocument()
  })

  test('an app that does not exist says so and links back', async () => {
    mockApi({ [`GET /api/apps/${APP_ID}`]: answer(404, { error: 'App not found' }) })
    page()
    expect(await screen.findByText('App not found', { selector: '[data-slot="alert-title"]' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /all apps/i })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
  })

  test('other failures offer to try again', async () => {
    mockApi({ [`GET /api/apps/${APP_ID}`]: answer(500, { error: 'Internal server error' }) })
    page()
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  test('the tab follows the address, and clicking a tab changes the address', async () => {
    mockApi(base())
    page(`/apps/${APP_ID}/deployments`)
    expect(await screen.findByRole('tab', { name: 'Deployments' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByRole('tab', { name: 'Variables' }))
    expect(screen.getByRole('tab', { name: 'Variables' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByRole('tab', { name: 'Overview' }))
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
  })

  test('the Images tab opens from its address', async () => {
    mockApi(base({ [`GET /api/apps/${APP_ID}/images`]: { keep_previous_images: 1, auto_prune: false, cleanup: null, prunableBytes: 0, versions: [] } }))
    page(`/apps/${APP_ID}/images`)
    expect(await screen.findByRole('tab', { name: 'Images' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('button', { name: /clean up now/i })).toBeInTheDocument()
  })

  test('an unknown tab in the address falls back to the overview', async () => {
    mockApi(base())
    page(`/apps/${APP_ID}/nonsense`)
    expect(await screen.findByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('settings that were edited but not deployed yet', () => {
  const edited = () => makeApp({
    host_port: 9000, memory_mb: 1024, settings_pending: ['host_port', 'memory_mb'],
    running_settings: { container_port: 3000, host_port: 8080, health_path: '/health', memory_mb: 512, cpus: 1 },
  })
  test('the overview shows what runs now, and says what is waiting', async () => {
    mockApi(base({ [`GET /api/apps/${APP_ID}`]: edited(), [`GET /api/apps/${APP_ID}/deployments`]: [makeDeployment()] }))
    page()
    expect(await screen.findByText('container 3000 → host 8080')).toBeInTheDocument()
    expect(screen.getByText('512 MB')).toBeInTheDocument()
    expect(screen.queryByText('1024 MB')).toBeNull()
    expect(screen.getByText(/Host port, Memory limit/)).toBeInTheDocument()
  })
  test('the link at the top still opens the port that answers', async () => {
    mockApi(base({ [`GET /api/apps/${APP_ID}`]: edited() }))
    page()
    expect(await screen.findByRole('link', { name: /open :8080/i })).toHaveAttribute('href', `http://${window.location.hostname}:8080`)
  })
  test('the Settings tab opens from its address', async () => {
    mockApi(base({ [`GET /api/apps/${APP_ID}`]: edited() }))
    page(`/apps/${APP_ID}/settings`)
    expect(await screen.findByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByLabelText('Host port')).toHaveValue('9000')
  })
})

describe('an app that is being deleted', () => {
  const deleting = (over = {}) => makeApp({ deleting_at: '2026-10-19T12:00:00Z', desired_state: 'stopped', ...over })
  test('shows that it is being deleted, with nothing to do', async () => {
    mockApi(base({ [`GET /api/apps/${APP_ID}`]: deleting() }))
    page()
    expect(await screen.findByText('This app is being deleted')).toBeInTheDocument()
    expect(screen.getByText('Deleting…')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('button', { name: /deploy/i })).toBeNull()
  })

  test('a failure says why and offers to try again, which sends the delete again', async () => {
    const api = mockApi(base({ [`GET /api/apps/${APP_ID}`]: deleting({ delete_error: 'docker said no' }), [`DELETE /api/apps/${APP_ID}`]: answer(202, { deleting: true }) }))
    page()
    expect(await screen.findByText('The app could not be deleted')).toBeInTheDocument()
    expect(screen.getByText('docker said no')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(api.called('DELETE', `/api/apps/${APP_ID}`)[0].body).toEqual({ confirm: 'My App' }))
  })

  test('when the app disappears afterwards that is a success: back to the list with a message', async () => {
    let gone = false
    mockApi(base({ [`GET /api/apps/${APP_ID}`]: () => { if (gone) throw { status: 404, body: { error: 'App not found' } }; return deleting() } }))
    const view = page()
    await screen.findByText('This app is being deleted')
    gone = true
    await view.client.invalidateQueries({ queryKey: ['app', APP_ID] })
    expect(await screen.findByText('home')).toBeInTheDocument()
    expect(toasts.success).toHaveBeenCalledWith('App deleted')
  })

  test('also when the deletion finishes before the page ever saw it marked', async () => {
    let gone = false
    const api = mockApi(base({
      [`GET /api/apps/${APP_ID}`]: () => { if (gone) throw { status: 404, body: { error: 'App not found' } }; return makeApp() },
      [`DELETE /api/apps/${APP_ID}`]: () => { gone = true; return answer(202, { deleting: true }) },
    }))
    page(`/apps/${APP_ID}/settings`)
    await userEvent.click(await screen.findByRole('button', { name: /delete app…/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText(/to confirm/i), 'My App')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete app' }))
    await waitFor(() => expect(api.called('DELETE', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(await screen.findByText('home', {}, { timeout: 8000 })).toBeInTheDocument()
    expect(toasts.success).toHaveBeenCalledWith('App deleted')
  }, 15000)

  test('a server error (not a 404) while it is being deleted is shown, not mistaken for success', async () => {
    let fail = false
    mockApi(base({ [`GET /api/apps/${APP_ID}`]: () => { if (fail) throw { status: 500, body: { error: 'Internal server error' } }; return deleting() } }))
    const view = page()
    await screen.findByText('This app is being deleted')
    fail = true
    await view.client.invalidateQueries({ queryKey: ['app', APP_ID] })
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
    expect(screen.queryByText('home')).toBeNull()
    expect(toasts.success).not.toHaveBeenCalledWith('App deleted')
  })

  test('a 404 for an app that was never being deleted is still "App not found"', async () => {
    mockApi(base({ [`GET /api/apps/${APP_ID}`]: answer(404, { error: 'App not found' }) }))
    page()
    expect((await screen.findAllByText('App not found')).length).toBeGreaterThan(0)
    expect(toasts.success).not.toHaveBeenCalled()
    expect(screen.queryByText('home')).toBeNull()
  })
})

describe('the overview', () => {
  test('includes the resource use card', async () => {
    mockApi(base({ [`GET /api/apps/${APP_ID}/stats`]: { latest: { cpuPercent: 4, memoryBytes: 50 * 1024 * 1024, memoryLimitBytes: null, sampledAt: 'x' }, samples: [] } }))
    page()
    expect(await screen.findByText('Resource use', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(await screen.findByText('4.0%')).toBeInTheDocument()
  })

  test('describes what is running, the limits, and the status the worker reported', async () => {
    mockApi(base({ [`GET /api/apps/${APP_ID}`]: makeApp({ runtime: { state: 'unhealthy', last_action: 'start', last_error: 'Started, but it did not pass its health check', health_failures: 3, last_exit_code: null, updated_at: '2026-10-19T11:00:00Z' } }) }))
    page()
    expect(await screen.findByText('bbbbbbb')).toBeInTheDocument()
    expect(screen.getByText('container 3000 → host 8080')).toBeInTheDocument()
    expect(screen.getByText('512 MB')).toBeInTheDocument()
    expect(screen.getByText('/health')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText(/did not pass its health check/)).toBeInTheDocument()
  })

  test('an app that was never deployed explains what to do', async () => {
    mockApi(base({ [`GET /api/apps/${APP_ID}`]: makeApp({ runtime: null, latest_deployment: null }), [`GET /api/apps/${APP_ID}/deployments`]: [] }))
    page()
    expect(await screen.findByText(/nothing has been deployed yet/i)).toBeInTheDocument()
  })

  test('crash history lists what happened and what Shipdok did about it', async () => {
    mockApi(base({ [`GET /api/apps/${APP_ID}/crashes`]: [
      { occurred_at: '2026-10-19T11:30:00Z', cause: 'crash', exit_code: 137, oom_killed: true, action: 'restarted' },
      { occurred_at: '2026-10-19T10:00:00Z', cause: 'stopped_outside', exit_code: 0, oom_killed: false, action: 'marked crashed' },
    ] }))
    page()
    expect(await screen.findByText('Crashed')).toBeInTheDocument()
    expect(screen.getByText(/exit 137, out of memory/)).toBeInTheDocument()
    expect(screen.getByText('Stopped outside Shipdok')).toBeInTheDocument()
    expect(screen.getByText('restarted')).toBeInTheDocument()
  })

  test('no crashes: says so', async () => {
    mockApi(base())
    page()
    expect(await screen.findByText('No crashes recorded')).toBeInTheDocument()
  })
})

describe('Deploy', () => {
  test('queues a deployment and says so', async () => {
    const api = mockApi(base({ [`POST /api/apps/${APP_ID}/deployments`]: answer(202, makeDeployment({ status: 'queued' })) }))
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)).toHaveLength(1))
    expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)[0].body).toEqual({})
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Deployment queued'))
  })

  test('"Deploy without cache" is in the menu, asks first, and sends noCache for that one deployment', async () => {
    const api = mockApi(base({ [`POST /api/apps/${APP_ID}/deployments`]: answer(202, makeDeployment({ status: 'queued' })) }))
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'More ways to deploy' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Deploy without cache/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/next push uses the cache again/)).toBeInTheDocument()
    expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)).toHaveLength(0) // only the question so far
    await userEvent.click(within(dialog).getByRole('button', { name: 'Deploy without cache' }))
    await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)).toHaveLength(1))
    expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)[0].body).toEqual({ noCache: true })
    await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)).toHaveLength(2))
    expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)[1].body).toEqual({}) // the plain button is still plain
  })

  test('cancelling the "without cache" question deploys nothing', async () => {
    const api = mockApi(base({}))
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'More ways to deploy' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Deploy without cache/ }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)).toHaveLength(0)
  })

  test('the "disk almost full" question keeps the no-cache choice', async () => {
    let n = 0
    const critical = answer(409, { error: 'The disk is almost full', code: 'disk_critical', disk: { freePercent: 5 } })
    const api = mockApi(base({ [`POST /api/apps/${APP_ID}/deployments`]: () => { n += 1; return n === 1 ? critical : answer(202, makeDeployment()) } }))
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'More ways to deploy' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Deploy without cache/ }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Deploy without cache' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Deploy anyway' }))
    await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)).toHaveLength(2))
    expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)[1].body).toEqual({ ignoreDiskWarning: true, noCache: true })
  })

  test('a warning from the API (the disk is getting full) is shown as a warning', async () => {
    mockApi(base({ [`POST /api/apps/${APP_ID}/deployments`]: answer(202, { ...makeDeployment(), warning: 'The disk is getting full (15% free).' }) }))
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(toasts.warning).toHaveBeenCalledWith('The disk is getting full (15% free).'))
  })

  test('a failure shows the API\'s message', async () => {
    mockApi(base({ [`POST /api/apps/${APP_ID}/deployments`]: answer(503, { error: 'Could not enqueue the deployment job' }) }))
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not enqueue the deployment job'))
  })

  describe('when the disk is almost full', () => {
    const critical = answer(409, { error: 'The disk is almost full...', code: 'disk_critical', disk: { level: 'critical', freePercent: 4 } })

    test('asks first, and "Stop" sends nothing more', async () => {
      const api = mockApi(base({ [`POST /api/apps/${APP_ID}/deployments`]: critical }))
      page()
      await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }))
      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByText(/only 4% is free/i)).toBeInTheDocument()
      await userEvent.click(within(dialog).getByRole('button', { name: 'Stop' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)).toHaveLength(1)
      expect(toasts.error).not.toHaveBeenCalled()
    })

    test('"Deploy anyway" repeats the request with the confirmation', async () => {
      let n = 0
      const api = mockApi(base({ [`POST /api/apps/${APP_ID}/deployments`]: () => { n += 1; return n === 1 ? critical : answer(202, { ...makeDeployment(), warning: 'Deployed although the disk is almost full.' }) } }))
      page()
      await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }))
      await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Deploy anyway' }))
      await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)).toHaveLength(2))
      expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)[1].body).toEqual({ ignoreDiskWarning: true })
    })

    test('"Deploy and start" of a stopped app keeps its choice through the question', async () => {
      let n = 0
      const api = mockApi(base({
        [`GET /api/apps/${APP_ID}`]: makeApp({ desired_state: 'stopped', runtime: { state: 'stopped' } }),
        [`POST /api/apps/${APP_ID}/deployments`]: () => { n += 1; return n === 1 ? critical : answer(202, makeDeployment()) },
      }))
      page()
      await userEvent.click(await screen.findByRole('button', { name: 'Deploy and start' }))
      await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Deploy anyway' }))
      await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)).toHaveLength(2))
      expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)[1].body).toEqual({ start: true, ignoreDiskWarning: true })
    })

    test('a different 409 is just an error message, not the disk question', async () => {
      mockApi(base({ [`POST /api/apps/${APP_ID}/deployments`]: answer(409, { error: 'Something else' }) }))
      page()
      await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }))
      await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Something else'))
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
  })

  test('a running app has no "Deploy and start"; a stopped one does, and it sends start: true', async () => {
    mockApi(base())
    const { unmount } = page()
    await screen.findByRole('button', { name: 'Deploy' })
    expect(screen.queryByRole('button', { name: 'Deploy and start' })).toBeNull()
    unmount()
    const api = mockApi(base({ [`GET /api/apps/${APP_ID}`]: makeApp({ desired_state: 'stopped', runtime: { state: 'stopped' } }), [`POST /api/apps/${APP_ID}/deployments`]: answer(202, makeDeployment()) }))
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Deploy and start' }))
    await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)).toHaveLength(1))
    expect(api.called('POST', `/api/apps/${APP_ID}/deployments`)[0].body).toEqual({ start: true })
  })
})

describe('Start, Stop and Restart', () => {
  test('a running app offers Restart and Stop; Stop asks first, Restart does not', async () => {
    const api = mockApi(base({ [`POST /api/apps/${APP_ID}/restart`]: answer(202, { action: 'restart' }), [`POST /api/apps/${APP_ID}/stop`]: answer(202, { action: 'stop' }) }))
    page()
    await screen.findByRole('heading', { name: 'My App' })
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/restart`)).toHaveLength(1))

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(api.called('POST', `/api/apps/${APP_ID}/stop`)).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/stop`)).toHaveLength(1))
  })

  test('cancelling the stop question stops nothing', async () => {
    const api = mockApi(base())
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(api.called('POST', `/api/apps/${APP_ID}/stop`)).toHaveLength(0)
  })

  test('a stopped app offers only Start', async () => {
    const api = mockApi(base({ [`GET /api/apps/${APP_ID}`]: makeApp({ desired_state: 'stopped', runtime: { state: 'stopped' } }), [`POST /api/apps/${APP_ID}/start`]: answer(202, {}) }))
    page()
    await screen.findByText('Stopped on purpose')
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/start`)).toHaveLength(1))
  })

  test('an app whose container was removed outside Shipdok says so, offers no Start/Stop/Restart, and Deploy is the way back', async () => {
    const msg = 'The container was removed outside Shipdok (for example with docker rm). Nothing is running. Deploy the app again to bring it back.'
    mockApi(base({
      [`GET /api/apps/${APP_ID}`]: makeApp({ runtime: { state: 'missing', last_error: msg } }),
      [`GET /api/apps/${APP_ID}/crashes`]: [{ occurred_at: '2026-10-19T11:30:00Z', cause: 'removed_outside', exit_code: null, oom_killed: false, action: 'none' }],
    }))
    page()
    expect(await screen.findByText('Missing')).toBeInTheDocument()
    expect(await screen.findByText(msg)).toBeInTheDocument()
    expect(screen.getByText('Removed outside Shipdok')).toBeInTheDocument()
    expect(screen.getByText('Last deployed')).toBeInTheDocument() // nothing runs now, so the card must not say it does
    expect(screen.queryByText('Running now')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeInTheDocument()
  })

  test('a crashed app offers Start and Restart (it stays down until you decide)', async () => {
    mockApi(base({ [`GET /api/apps/${APP_ID}`]: makeApp({ runtime: { state: 'crashed' } }) }))
    page()
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  test('an error from the API is shown', async () => {
    mockApi(base({ [`POST /api/apps/${APP_ID}/restart`]: answer(503, { error: 'Could not queue the request' }) }))
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not queue the request'))
  })
})
