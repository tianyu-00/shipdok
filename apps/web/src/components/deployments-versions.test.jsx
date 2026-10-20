import { describe, test, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
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
    const row = await rowOf(text)
    await userEvent.click(within(row).getByRole('button', { name: /^log$/i }))
    return await waitFor(() => { if (!row.nextElementSibling?.id?.startsWith('log-')) throw new Error('the log is not open yet'); return row.nextElementSibling })
  }

  test('asks first, then deletes that deployment\'s log and closes the console', async () => {
    const api = mockApi({ [LIST]: deployments, [IMAGES]: images, [LOG]: logOf, 'DELETE /api/deployments/old/logs': { freedBytes: 2048 } })
    tab()
    const dialog = await openLog('ccccccc')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete this log' }))
    const ask = await screen.findByRole('alertdialog')
    expect(api.called('DELETE', '/api/deployments/old/logs')).toHaveLength(0)
    await userEvent.click(within(ask).getByRole('button', { name: 'Delete log' }))
    await waitFor(() => expect(api.called('DELETE', '/api/deployments/old/logs')).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Log deleted (2.0 KB)'))
    await waitFor(() => expect(document.getElementById('log-old')).toBeNull())
  })

  test('a refusal is shown and the console stays', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, [LOG]: logOf, 'DELETE /api/deployments/old/logs': answer(500, { error: 'The log files could not be deleted' }) })
    tab()
    await userEvent.click(within(await openLog('ccccccc')).getByRole('button', { name: 'Delete this log' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete log' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('The log files could not be deleted'))
    expect(document.getElementById('log-old')).not.toBeNull()
  })

  test('is not offered while the deployment is still running', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, 'GET /api/deployments/run/logs': logOf })
    tab()
    const dialog = await openLog('fffffff')
    expect(within(dialog).queryByRole('button', { name: 'Delete this log' })).toBeNull()
  })
})

describe('pressing a row', () => {
  const LOGS = (id) => ({ [`GET /api/deployments/${id}/logs`]: { text: '2026-10-19T12:00:00.000Z shipdok hello\n', offset: 0, nextOffset: 40, size: 40, complete: true, truncated: false } })
  const logRow = (id) => document.getElementById(`log-${id}`)

  test('anywhere on the row opens its log, and pressing the row again closes it', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, ...LOGS('prev') })
    tab()
    const row = await rowOf('bbbbbbb')
    await userEvent.click(within(row).getByText('bbbbbbb'))
    expect(logRow('prev')).not.toBeNull()
    expect(row.nextElementSibling).toBe(logRow('prev'))
    await userEvent.click(within(row).getByText('bbbbbbb'))
    expect(logRow('prev')).toBeNull()
  })

  test('the row says it can be opened: a pointer, and an arrow that turns when it is open', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, ...LOGS('prev') })
    tab()
    const row = await rowOf('bbbbbbb')
    expect(row.className).toMatch(/cursor-pointer/)
    const arrow = row.querySelector('svg.lucide-chevron-right')
    expect(arrow.getAttribute('class')).not.toMatch(/rotate-90/)
    await userEvent.click(row)
    expect(row.querySelector('svg.lucide-chevron-right').getAttribute('class')).toMatch(/rotate-90/)
  })

  test('the actions are icons only, each with a name and a tooltip', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images })
    tab()
    const row = await rowOf('ccccccc') // an old version: it can be rolled back to and deleted
    for (const [name, title] of [['Log', 'Show log'], ['Roll back', 'Roll back to this version'], ['Delete', 'Delete this deployment']]) {
      const button = within(row).getByRole('button', { name: new RegExp(`^${name}`) })
      expect(button).toHaveAttribute('title', title)
      expect(button.textContent).toBe('') // an icon, no words next to it
    }
  })

  test('a Delete that is not allowed says why in its tooltip', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images })
    tab()
    const button = within(await rowOf('aaaaaaa')).getByRole('button', { name: /^Delete \(unavailable/ })
    expect(button).toBeDisabled()
    expect(button.getAttribute('title')).toMatch(/running version/i)
  })

  test('the Log button still works on its own, and presses once (it does not also toggle through the row)', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, ...LOGS('prev') })
    tab()
    const row = await rowOf('bbbbbbb')
    await userEvent.click(within(row).getByRole('button', { name: /^log$/i }))
    expect(logRow('prev')).not.toBeNull() // opened, not opened-and-closed again
    await userEvent.click(within(row).getByRole('button', { name: /hide log/i }))
    expect(logRow('prev')).toBeNull()
  })

  test('Roll back and Delete do their own thing and leave the log closed', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, ...LOGS('prev'), ...LOGS('old') })
    tab()
    await userEvent.click(within(await rowOf('bbbbbbb')).getByRole('button', { name: 'Roll back' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(logRow('prev')).toBeNull()
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await userEvent.click(within(await rowOf('ccccccc')).getByRole('button', { name: 'Delete' }))
    await screen.findByRole('alertdialog')
    expect(logRow('old')).toBeNull()
  })

  test('Cancel of a running deployment cancels it and does not open the log', async () => {
    const api = mockApi({ [LIST]: deployments, [IMAGES]: images, 'POST /api/deployments/run/cancel': { status: 'building' }, ...LOGS('run') })
    tab()
    await userEvent.click(within(await rowOf('fffffff')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(api.called('POST', '/api/deployments/run/cancel')).toHaveLength(1))
    expect(logRow('run')).toBeNull()
  })

  test('pressing a row that ended a text selection (copying the commit id) does not toggle it', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, ...LOGS('prev') })
    tab()
    const spy = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'bbbbbbb' })
    await userEvent.click(within(await rowOf('bbbbbbb')).getByText('bbbbbbb'))
    expect(logRow('prev')).toBeNull()
    spy.mockReturnValue({ toString: () => '' })
    await userEvent.click(within(await rowOf('bbbbbbb')).getByText('bbbbbbb'))
    expect(logRow('prev')).not.toBeNull()
    spy.mockRestore()
  })

  test('pressing a row twice quickly does not select a word, but a single press can still start a text selection', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images })
    tab()
    const cell = within(await rowOf('bbbbbbb')).getByText('bbbbbbb')
    expect(fireEvent.mouseDown(cell, { detail: 2 })).toBe(false) // false: the default (selecting the word) was prevented
    expect(fireEvent.mouseDown(cell, { detail: 3 })).toBe(false)
    expect(fireEvent.mouseDown(cell, { detail: 1 })).toBe(true) // a drag to select text is still allowed
  })

  test('two quick presses open the log and close it again, whatever is selected afterwards', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, ...LOGS('prev') })
    tab()
    const row = await rowOf('bbbbbbb')
    await userEvent.dblClick(within(row).getByText('bbbbbbb'))
    expect(logRow('prev')).toBeNull() // opened by the first press, closed by the second
    await userEvent.click(within(row).getByText('bbbbbbb'))
    expect(logRow('prev')).not.toBeNull()
  })

  test('pressing inside the open console does not close it', async () => {
    mockApi({ [LIST]: deployments, [IMAGES]: images, ...LOGS('prev') })
    tab()
    await userEvent.click(await rowOf('bbbbbbb'))
    const input = await within(logRow('prev')).findByLabelText('Find in log')
    await userEvent.type(input, 'hel')
    expect(logRow('prev')).not.toBeNull()
  })
})
