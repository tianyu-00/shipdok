import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DeploymentsTab from './deployments-tab'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { makeApp, makeDeployment, makeImages, makeVersion, APP_ID } from '@/test/fixtures'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const LIST = `GET /api/apps/${APP_ID}/deployments`
const IMAGES = `GET /api/apps/${APP_ID}/images`
const sha = (c) => c.repeat(40)
const deployments = [
  makeDeployment({ id: 'live', commit_sha: sha('a') }), makeDeployment({ id: 'prev', commit_sha: sha('b') }),
  makeDeployment({ id: 'old', commit_sha: sha('c') }), makeDeployment({ id: 'gone', commit_sha: sha('d') }),
  makeDeployment({ id: 'bad', status: 'failed', commit_sha: sha('e'), image_ref: null }), makeDeployment({ id: 'run', status: 'building', commit_sha: sha('f') }),
]
const images = makeImages([
  makeVersion({ deploymentId: 'live', image: 'i:live', state: 'live' }),
  makeVersion({ deploymentId: 'prev', image: 'i:prev', state: 'previous', canRollBackTo: true }),
  makeVersion({ deploymentId: 'old', image: 'i:old', state: 'prunable', canRollBackTo: true }),
  makeVersion({ deploymentId: 'gone', image: 'i:gone', state: 'removed' }),
])
const tab = (app = makeApp()) => renderWithProviders(<DeploymentsTab app={app} />)
const rowOf = async (text) => (await screen.findByText(text)).closest('tr')

describe('versions in the history', () => {
  test('each successful row says which version it is', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images })
    tab()
    const live = await rowOf('aaaaaaa')
    await within(live).findByText('Live')
    expect(within(await rowOf('bbbbbbb')).getByText('Previous')).toBeInTheDocument()
    expect(within(await rowOf('ccccccc')).getByText('Old image')).toBeInTheDocument()
    expect(within(await rowOf('ddddddd')).getByText('Image removed')).toBeInTheDocument()
  })

  test('roll back is offered only where an image still exists', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images })
    tab()
    await within(await rowOf('bbbbbbb')).findByRole('button', { name: /roll back/i })
    expect(within(await rowOf('ccccccc')).getByRole('button', { name: /roll back/i })).toBeInTheDocument()
    for (const c of ['aaaaaaa', 'ddddddd', 'eeeeeee', 'fffffff']) expect(within(await rowOf(c)).queryByRole('button', { name: /roll back/i })).toBeNull()
  })

  test('the history still works when the images cannot be loaded', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: answer(500, { error: 'boom' }) })
    tab()
    expect(await rowOf('aaaaaaa')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /roll back/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })
})

describe('rolling back', () => {
  test('asks first, then sends that exact version', async () => {
    const api = mockApi({ [LIST]: deployments, [IMAGES]: images, [`POST /api/apps/${APP_ID}/rollback`]: makeDeployment({ id: 'new', trigger: 'rollback' }) })
    tab()
    await userEvent.click(within(await rowOf('bbbbbbb')).getByRole('button', { name: /roll back/i }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/no new build/i)).toBeInTheDocument()
    expect(api.called('POST', `/api/apps/${APP_ID}/rollback`)).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }))
    await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/rollback`)).toHaveLength(1))
    expect(api.called('POST', `/api/apps/${APP_ID}/rollback`)[0].body).toEqual({ deploymentId: 'prev' })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Rollback queued'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('a stopped app offers to stay stopped or to start', async () => {
    const api = mockApi({ [LIST]: deployments, [IMAGES]: images, [`POST /api/apps/${APP_ID}/rollback`]: makeDeployment({ id: 'new' }) })
    tab(makeApp({ desired_state: 'stopped' }))
    await userEvent.click(within(await rowOf('bbbbbbb')).getByRole('button', { name: /roll back/i }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/stays stopped/i)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back and start' }))
    await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/rollback`)[0].body).toEqual({ deploymentId: 'prev', start: true }))
  })

  test('a running app has no start option', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images })
    tab()
    await userEvent.click(within(await rowOf('bbbbbbb')).getByRole('button', { name: /roll back/i }))
    expect(within(await screen.findByRole('dialog')).queryByRole('button', { name: /and start/i })).toBeNull()
  })

  test('a refusal from the API is shown and the dialog stays for another try', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, [`POST /api/apps/${APP_ID}/rollback`]: answer(409, { error: 'The image of that version was removed' }) })
    tab()
    await userEvent.click(within(await rowOf('bbbbbbb')).getByRole('button', { name: /roll back/i }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Roll back' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('The image of that version was removed'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('deleting a deployment', () => {
  test('is blocked, with the reason, for the running and the kept version', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images })
    tab()
    const live = await rowOf('aaaaaaa')
    const liveBtn = await within(live).findByRole('button', { name: /delete/i })
    expect(liveBtn).toBeDisabled()
    expect(liveBtn.getAttribute('aria-label')).toMatch(/running version/i)
    expect(within(await rowOf('bbbbbbb')).getByRole('button', { name: /delete/i })).toBeDisabled()
    for (const c of ['ccccccc', 'ddddddd', 'eeeeeee']) expect(within(await rowOf(c)).getByRole('button', { name: /^delete$/i })).toBeEnabled()
  })

  test('a running build offers Cancel, not Delete', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images })
    tab()
    await within(await rowOf('aaaaaaa')).findByRole('button', { name: /delete/i })
    expect(within(await rowOf('fffffff')).queryByRole('button', { name: /delete/i })).toBeNull()
  })

  test('asks once, then deletes that deployment', async () => {
    const api = mockApi({ [LIST]: deployments, [IMAGES]: images, 'DELETE /api/deployments/old': { deleted: true } })
    tab()
    await userEvent.click(await within(await rowOf('ccccccc')).findByRole('button', { name: /^delete$/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/image is removed too/i)).toBeInTheDocument()
    expect(within(dialog).queryByRole('textbox')).toBeNull() // nothing to type
    expect(api.called('DELETE', '/api/deployments/old')).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete deployment' }))
    await waitFor(() => expect(api.called('DELETE', '/api/deployments/old')).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Deployment deleted'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  test('cancel deletes nothing', async () => {
    const api = mockApi({ [LIST]: deployments, [IMAGES]: images })
    tab()
    await userEvent.click(await within(await rowOf('ccccccc')).findByRole('button', { name: /^delete$/i }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  test('a deployment without an image does not claim to remove one', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images })
    tab()
    await userEvent.click(await within(await rowOf('eeeeeee')).findByRole('button', { name: /^delete$/i }))
    expect(within(await screen.findByRole('alertdialog')).queryByText(/image is removed too/i)).toBeNull()
  })

  test('the API\'s refusal is shown', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, 'DELETE /api/deployments/old': answer(409, { error: 'A rollback to this version is waiting to run' }) })
    tab()
    await userEvent.click(await within(await rowOf('ccccccc')).findByRole('button', { name: /^delete$/i }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete deployment' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('A rollback to this version is waiting to run'))
  })
})

describe('labels follow the history', () => {
  test('when a deployment finishes the version labels are re-read straight away', async () => {
    let finished = false
    let imageReads = 0
    mockApi({
      [LIST]: () => [makeDeployment({ id: 'new', status: finished ? 'successful' : 'building', commit_sha: sha('a') }), makeDeployment({ id: 'old', commit_sha: sha('b') })],
      [IMAGES]: () => { imageReads += 1; return makeImages([makeVersion({ deploymentId: finished ? 'new' : 'old', image: finished ? 'i:new' : 'i:old', state: 'live' })]) },
    })
    const { client } = tab()
    await within(await rowOf('bbbbbbb')).findByText('Live')
    const before = imageReads
    finished = true
    await client.invalidateQueries({ queryKey: ['deployments', APP_ID] })
    await within(await rowOf('aaaaaaa')).findByText('Live')
    expect(imageReads).toBeGreaterThan(before)
  })
})

describe('deleting a build log', () => {
  const LOG = 'GET /api/deployments/old/logs'
  const logOf = { text: '2026-10-19T12:00:00.000Z shipdok hi\n', offset: 0, nextOffset: 40, size: 40, complete: true, truncated: false }
  const openLog = async (text) => {
    await userEvent.click(within(await rowOf(text)).getByRole('button', { name: /^log$/i }))
    return screen.findByRole('dialog')
  }

  test('asks first, then deletes that deployment\'s log and closes the window', async () => {
    const api = mockApi({ [LIST]: deployments, [IMAGES]: images, [LOG]: logOf, 'DELETE /api/deployments/old/logs': { freedBytes: 2048 } })
    tab()
    const dialog = await openLog('ccccccc')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete this log' }))
    const ask = await screen.findByRole('alertdialog')
    expect(api.called('DELETE', '/api/deployments/old/logs')).toHaveLength(0)
    await userEvent.click(within(ask).getByRole('button', { name: 'Delete log' }))
    await waitFor(() => expect(api.called('DELETE', '/api/deployments/old/logs')).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Log deleted (2.0 KB)'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('a refusal is shown and the window stays', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, [LOG]: logOf, 'DELETE /api/deployments/old/logs': answer(500, { error: 'The log files could not be deleted' }) })
    tab()
    await userEvent.click(within(await openLog('ccccccc')).getByRole('button', { name: 'Delete this log' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete log' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('The log files could not be deleted'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  test('is not offered while the deployment is still running', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, 'GET /api/deployments/run/logs': logOf })
    tab()
    const dialog = await openLog('fffffff')
    expect(within(dialog).queryByRole('button', { name: 'Delete this log' })).toBeNull()
  })
})
