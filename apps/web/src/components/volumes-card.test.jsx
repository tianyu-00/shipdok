import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import VolumesCard from './volumes-card'
import { mockApi, renderWithProviders } from '@/test/utils'
import { makeApp, makeVolume, APP_ID } from '@/test/fixtures'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const URL = `/api/apps/${APP_ID}/volumes`
const GET = `GET ${URL}`
const PUT = `PUT ${URL}`
const IDLE = { measuring: false, finishedAt: null, error: null, totalBytes: 0, measured: 0 }
const card = (volumes = []) => { const api = mockApi({ [GET]: { volumes }, [PUT]: { volumes }, 'GET /api/volumes/sizes': IDLE }); renderWithProviders(<VolumesCard app={makeApp()} />); return api }
const save = () => screen.getByRole('button', { name: 'Save storage' })

describe('persistent storage', () => {
  test('explains what it is for, the permissions catch, and that a removed path keeps its data', async () => {
    card()
    expect(await screen.findByText(/survive redeploys/i)).toBeInTheDocument()
    expect(screen.getByText(/non-root user/i)).toBeInTheDocument()
    expect(screen.getByText(/not deleted/i)).toBeInTheDocument()
    expect(screen.getByText(/next deployment/i)).toBeInTheDocument()
  })

  test('says up front, in the card itself, not to use the folder the app\'s code lives in', async () => {
    card()
    expect(await screen.findByText(/do not use the folder your app's code is in/i)).toBeInTheDocument()
    expect(screen.getByText(/old code/i)).toBeInTheDocument()
  })

  test('typing a code folder such as /app shows a warning, but adding it is still allowed', async () => {
    card()
    await screen.findByText(/survive redeploys/i)
    await userEvent.type(screen.getByLabelText('Add a path'), '/app')
    expect(screen.getByText(/probably the folder your app's code lives in/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add path' }))
    expect(screen.getAllByText('/app').length).toBeGreaterThan(0)
    expect(save()).toBeEnabled()
  })

  test('a data folder inside it, or any other path, shows no warning', async () => {
    card()
    await screen.findByText(/survive redeploys/i)
    for (const ok of ['/app/data', '/data']) {
      await userEvent.clear(screen.getByLabelText('Add a path'))
      await userEvent.type(screen.getByLabelText('Add a path'), ok)
      expect(screen.queryByText(/probably the folder your app's code lives in/i)).toBeNull()
    }
  })

  test('a path that is already saved and is a code folder is flagged on its row', async () => {
    card([makeVolume({ path: '/app' }), makeVolume({ id: 'v2', path: '/data' })])
    const row = (await screen.findByText('/app')).closest('li')
    expect(within(row).getByText(/probably the folder your app's code lives in/i)).toBeInTheDocument()
    expect(within(screen.getByText('/data').closest('li')).queryByText(/probably the folder/i)).toBeNull()
  })

  test('lists the paths that are mounted, with the Docker name for a manual backup', async () => {
    card([makeVolume({ path: '/data', dockerName: 'shipdok-vol-aaa' }), makeVolume({ id: 'v2', path: '/uploads', dockerName: 'shipdok-vol-bbb' })])
    expect(await screen.findByText('/data')).toBeInTheDocument()
    expect(screen.getByText('/uploads')).toBeInTheDocument()
    expect(screen.getByText('shipdok-vol-aaa')).toBeInTheDocument()
    expect(save()).toBeDisabled()
  })

  test('adding a path sends the whole list (tidied), and says deploying is needed', async () => {
    const api = card([makeVolume({ path: '/data' })])
    await screen.findByText('/data')
    await userEvent.type(screen.getByLabelText('Add a path'), '/app//uploads/')
    await userEvent.click(screen.getByRole('button', { name: 'Add path' }))
    expect(screen.getByText('/app/uploads')).toBeInTheDocument()
    expect(save()).toBeEnabled()
    await userEvent.click(save())
    await waitFor(() => expect(api.called('PUT', URL)).toHaveLength(1))
    expect(api.called('PUT', URL)[0].body).toEqual({ paths: ['/app/uploads', '/data'] })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Saved. Deploy to apply the changes.'))
  })

  test('removing a path sends the shorter list, and the text says the data is kept', async () => {
    const api = card([makeVolume({ path: '/data' }), makeVolume({ id: 'v2', path: '/uploads' })])
    await screen.findByText('/data')
    await userEvent.click(screen.getByRole('button', { name: 'Remove /uploads' }))
    expect(screen.queryByText('/uploads')).toBeNull()
    await userEvent.click(save())
    await waitFor(() => expect(api.called('PUT', URL)[0].body).toEqual({ paths: ['/data'] }))
  })

  test('a path the server would refuse is caught first, with the reason, and nothing is sent', async () => {
    const api = card()
    await screen.findByText(/survive redeploys/i)
    for (const bad of ['relative', '/', '/proc/x']) {
      await userEvent.clear(screen.getByLabelText('Add a path'))
      await userEvent.type(screen.getByLabelText('Add a path'), bad)
      await userEvent.click(screen.getByRole('button', { name: 'Add path' }))
      expect(await screen.findByRole('alert')).toBeInTheDocument()
    }
    expect(api.called('PUT', URL)).toHaveLength(0)
  })

  test('the same path twice and a path inside another are refused', async () => {
    card([makeVolume({ path: '/data' })])
    await screen.findByText('/data')
    for (const bad of ['/data/', '/data/sub']) {
      await userEvent.clear(screen.getByLabelText('Add a path'))
      await userEvent.type(screen.getByLabelText('Add a path'), bad)
      await userEvent.click(screen.getByRole('button', { name: 'Add path' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(/twice|inside/)
    }
  })

  test('volumes that are kept but not mounted are shown separately, with a way to bring one back', async () => {
    card([makeVolume({ path: '/data' }), makeVolume({ id: 'v2', path: '/old', state: 'detached' })])
    await screen.findByText('/data')
    const kept = screen.getByRole('region', { name: /kept but not mounted/i })
    expect(within(kept).getByText('/old')).toBeInTheDocument()
    expect(within(kept).getByText(/adding the same path again brings it back/i)).toBeInTheDocument()
  })

  test('the server\'s refusal is shown', async () => {
    mockApi({ [GET]: { volumes: [] }, [PUT]: () => { throw { status: 409, body: { error: 'This app is being deleted', code: 'deleting' } } } })
    renderWithProviders(<VolumesCard app={makeApp()} />)
    await screen.findByText(/survive redeploys/i)
    await userEvent.type(screen.getByLabelText('Add a path'), '/data')
    await userEvent.click(screen.getByRole('button', { name: 'Add path' }))
    await userEvent.click(save())
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('This app is being deleted'))
  })
})

describe('the size of each path', () => {
  const m = (min) => new Date(Date.now() - min * 60_000).toISOString()

  test('a measured volume shows its size and when it was measured', async () => {
    card([makeVolume({ path: '/data', sizeBytes: 5 * 1024 * 1024, measuredAt: m(3) })])
    expect(await screen.findByText('5.0 MB, measured 3 min ago')).toBeInTheDocument()
  })

  test('one that was never measured says so', async () => {
    card([makeVolume({ path: '/data' })])
    expect(await screen.findByText('Size not measured yet')).toBeInTheDocument()
  })

  test('one that was measured while Docker had no such volume yet says it is not created yet', async () => {
    card([makeVolume({ path: '/data', sizeBytes: null, measuredAt: m(1) })])
    expect(await screen.findByText(/Not created in Docker yet/)).toBeInTheDocument()
  })

  test('zero bytes is a size, not "not measured"', async () => {
    card([makeVolume({ path: '/data', sizeBytes: 0, measuredAt: m(1) })])
    expect(await screen.findByText('0 B, measured 1 min ago')).toBeInTheDocument()
  })

  test('each path has its own', async () => {
    card([makeVolume({ id: 'a', path: '/a', sizeBytes: 1024, measuredAt: m(1) }), makeVolume({ id: 'b', path: '/b', sizeBytes: 2048, measuredAt: m(1) })])
    expect(await screen.findByText('1.0 KB, measured 1 min ago')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB, measured 1 min ago')).toBeInTheDocument()
  })

  test('a path typed but not saved yet has no size line', async () => {
    card([])
    await userEvent.type(await screen.findByLabelText('Add a path'), '/new')
    await userEvent.click(screen.getByRole('button', { name: /add path/i }))
    expect(screen.queryByText(/measured|Size not measured/)).toBeNull()
  })

  test('"Measure sizes" is offered when there are volumes (once it knows nothing is running)', async () => {
    card([makeVolume({ path: '/data' })])
    const button = await screen.findByRole('button', { name: 'Measure sizes' })
    await waitFor(() => expect(button).toBeEnabled())
  })

  test('no volumes, nothing to measure', async () => {
    card([])
    await screen.findByLabelText('Add a path')
    expect(screen.queryByRole('button', { name: /measure sizes/i })).toBeNull()
  })

  test('a volume that is only kept (detached) can be measured too', async () => {
    card([makeVolume({ state: 'detached', path: '/kept' })])
    expect(await screen.findByRole('button', { name: 'Measure sizes' })).toBeInTheDocument()
  })
})
