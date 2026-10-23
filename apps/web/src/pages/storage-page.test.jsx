import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StoragePage from './storage-page'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { makeApp, makeVolume, APP_ID } from '@/test/fixtures'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const MB = 1024 * 1024
const storage = (over = {}) => ({
  logs: { totalBytes: 3 * MB, apps: [{ appId: APP_ID, slug: 'my-app', bytes: 3 * MB, files: 4 }] },
  images: { totalBytes: 100 * MB, apps: [{ appId: APP_ID, slug: 'my-app', images: 2, bytes: 100 * MB }] },
  volumes: { totalBytes: 0, measuredAt: null, apps: [] },
  disk: { totalBytes: 100 * 1024 * MB, freeBytes: 60 * 1024 * MB, freePercent: 60, level: 'ok' },
  ...over,
})
const IDLE = { measuring: false, finishedAt: null, error: null, totalBytes: 0, measured: 0 }
const OLD = { reclaimableBytes: 0, apps: [], autoCleanup: { on: 0, total: 0 }, thresholdBytes: null, exceeded: false }
const routes = (over = {}) => ({ 'GET /api/storage': storage(), 'GET /api/images': OLD, 'GET /api/volumes/sizes': IDLE, 'GET /api/apps': [makeApp()], 'GET /api/volumes': { volumes: [] }, 'GET /api/build-cache': { totalBytes: null, reclaimableBytes: null, sampledAt: null, cleaning: false, last: null }, ...over })
const page = () => renderWithProviders(<StoragePage />, { route: '/storage' })
const BACKUPS = { backups: [], totalBytes: 0, schedule: { frequency: 'daily', hour: 3, weekday: 1, keep: 7 }, nextRunAt: null, apps: [], encryption: { enabled: false }, persistent: true }

describe('backups on the storage page', () => {
  test('are a card of their own, after the build cache and before the kept volumes', async () => {
    mockApi(routes({ 'GET /api/backups': BACKUPS }))
    page()
    const backups = await screen.findByText('Backups of Shipdok')
    const cache = screen.getByText('Build cache')
    const kept = screen.getByText('Volumes kept without an app')
    const appData = await screen.findByText("Backups of your apps' data")
    expect(cache.compareDocumentPosition(backups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(backups.compareDocumentPosition(appData) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(appData.compareDocumentPosition(kept) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Back up now' })).toBeInTheDocument()
  })
})

describe('the storage page', () => {
  test('shows the disk and what each app takes', async () => {
    mockApi(routes())
    page()
    expect(await screen.findByText('Plenty of space')).toBeInTheDocument()
    expect(screen.getByText(/60\.0 GB free of 100 GB \(60% free\)/)).toBeInTheDocument()
    const row = (await screen.findByRole('link', { name: 'My App' })).closest('tr')
    expect(within(row).getByText(/3\.0 MB/)).toBeInTheDocument()
    expect(within(row).getByText(/4 files/)).toBeInTheDocument()
    expect(within(row).getByText(/100 MB/)).toBeInTheDocument()
    expect(within(row).getByText(/2 images/)).toBeInTheDocument()
    expect(within(row).getByText('103 MB')).toBeInTheDocument()
  })

  test('the build cache card is on the page', async () => {
    mockApi(routes())
    page()
    expect(await screen.findByText('Build cache')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Clean unused cache' })).toBeInTheDocument()
  })

  test('the bar shows how much is used, and turns red when the disk is almost full', async () => {
    mockApi(routes({ 'GET /api/storage': storage({ disk: { totalBytes: 100 * MB, freeBytes: 8 * MB, freePercent: 8, level: 'critical' } }) }))
    page()
    const bar = await screen.findByRole('img', { name: '92% used' })
    expect(bar.firstChild).toHaveStyle({ width: '92%' })
    expect(bar.firstChild.className).toMatch(/bg-destructive/)
  })

  test('the bar is the normal colour when there is plenty of space', async () => {
    mockApi(routes())
    page()
    const bar = await screen.findByRole('img', { name: '40% used' })
    expect(bar.firstChild.className).toMatch(/bg-primary/)
  })

  test.each([['low', 'Getting full'], ['critical', 'Almost full']])('a %s disk is labelled', async (level, label) => {
    mockApi(routes({ 'GET /api/storage': storage({ disk: { totalBytes: 100 * MB, freeBytes: 5 * MB, freePercent: 5, level } }) }))
    page()
    expect(await screen.findByText(label)).toBeInTheDocument()
  })

  test('nothing stored yet', async () => {
    mockApi(routes({ 'GET /api/storage': storage({ logs: { totalBytes: 0, apps: [] }, images: { totalBytes: 0, apps: [] } }) }))
    page()
    expect(await screen.findByText('Nothing stored yet')).toBeInTheDocument()
  })

  test('a load failure can be retried', async () => {
    mockApi(routes({ 'GET /api/storage': answer(500, { error: 'x' }) }))
    page()
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  test('links to the app\'s images', async () => {
    mockApi(routes())
    page()
    expect(await screen.findByRole('link', { name: 'Images' })).toHaveAttribute('href', `/apps/${APP_ID}/images`)
  })
})

describe('the sizes of the persistent volumes', () => {
  const vol = (over = {}) => ({ volumes: { totalBytes: 12 * MB, measuredAt: '2026-10-19T11:00:00Z', apps: [{ appId: APP_ID, slug: 'my-app', count: 2, measured: 2, bytes: 12 * MB }] }, ...over })
  const row = async () => (await screen.findByRole('link', { name: 'My App' })).closest('tr')
  const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent)

  test('a Volumes column sits between the images and the total', async () => {
    mockApi(routes())
    page()
    await row()
    expect(headers()).toEqual(['App', 'Logs', 'Images (up to)', 'Volumes', 'Total', 'Actions'])
  })

  test('an app with no volumes says "none"', async () => {
    mockApi(routes())
    page()
    expect(within(await row()).getByText('none')).toBeInTheDocument()
  })

  test('volumes that were never measured say "not measured" and add nothing to the total', async () => {
    mockApi(routes({ 'GET /api/storage': storage({ volumes: { totalBytes: 0, measuredAt: null, apps: [{ appId: APP_ID, slug: 'my-app', count: 2, measured: 0, bytes: 0 }] } }) }))
    page()
    const r = await row()
    expect(within(r).getByText('not measured')).toBeInTheDocument()
    expect(within(r).getByText('(2 volumes)')).toBeInTheDocument()
    expect(within(r).getByText('103 MB')).toBeInTheDocument()
  })

  test('measured volumes show their size and are in the total', async () => {
    mockApi(routes({ 'GET /api/storage': storage(vol()) }))
    page()
    const r = await row()
    expect(within(r).getByText('12.0 MB')).toBeInTheDocument()
    expect(within(r).getByText('(2 volumes)')).toBeInTheDocument()
    expect(within(r).getByText('115 MB')).toBeInTheDocument() // 3 + 100 + 12
  })

  test('a single volume is not pluralised', async () => {
    mockApi(routes({ 'GET /api/storage': storage({ volumes: { totalBytes: MB, measuredAt: '2026-10-19T11:00:00Z', apps: [{ appId: APP_ID, slug: 'my-app', count: 1, measured: 1, bytes: MB }] } }) }))
    page()
    expect(within(await row()).getByText('(1 volume)')).toBeInTheDocument()
  })

  test('some measured, some not (a path added since): says how many were', async () => {
    mockApi(routes({ 'GET /api/storage': storage({ volumes: { totalBytes: 5 * MB, measuredAt: '2026-10-19T11:00:00Z', apps: [{ appId: APP_ID, slug: 'my-app', count: 3, measured: 2, bytes: 5 * MB }] } }) }))
    page()
    const r = await row()
    expect(within(r).getByText('5.0 MB')).toBeInTheDocument()
    expect(within(r).getByText('(2 of 3 measured)')).toBeInTheDocument()
  })

  test('the total in the card text includes the volumes', async () => {
    mockApi(routes({ 'GET /api/storage': storage(vol()) }))
    page()
    expect(await screen.findByText(/12\.0 MB of volumes/)).toBeInTheDocument()
  })

  test('an app that only has volumes still has a row', async () => {
    mockApi(routes({ 'GET /api/storage': storage({ logs: { totalBytes: 0, apps: [] }, images: { totalBytes: 0, apps: [] }, volumes: { totalBytes: MB, measuredAt: '2026-10-19T11:00:00Z', apps: [{ appId: APP_ID, slug: 'my-app', count: 1, measured: 1, bytes: MB }] } }) }))
    page()
    expect(within(await row()).getByText('1.0 MB', { selector: 'td:nth-child(4)' })).toBeInTheDocument()
  })

  describe('"Measure sizes"', () => {
    const button = () => screen.findByRole('button', { name: /measure sizes|measuring/i })

    test('before any: says not measured yet', async () => {
      mockApi(routes())
      page()
      expect(await screen.findByText('Not measured yet.')).toBeInTheDocument()
      expect(await button()).toHaveTextContent('Measure sizes')
    })

    test('after one: says when', async () => {
      mockApi(routes({ 'GET /api/volumes/sizes': { ...IDLE, finishedAt: new Date(Date.now() - 5 * 60_000).toISOString(), measured: 2 } }))
      page()
      expect(await screen.findByText('Measured 5 min ago.')).toBeInTheDocument()
    })

    test('pressing it asks the API once and shows that it is measuring, with the button off', async () => {
      let measuring = false
      const api = mockApi(routes({ 'GET /api/volumes/sizes': () => ({ ...IDLE, measuring }), 'POST /api/volumes/sizes': () => { measuring = true; return answer(202, { queued: true }) } }))
      page()
      await userEvent.click(await button())
      await waitFor(() => expect(api.called('POST', '/api/volumes/sizes')).toHaveLength(1))
      const b = await screen.findByRole('button', { name: 'Measuring…' })
      expect(b).toBeDisabled()
      expect(await screen.findByText(/adds up every file, which can take a while/)).toBeInTheDocument()
    })

    test('while the request itself is on its way the button is already off, so a double press sends one', async () => {
      let release
      const gate = new Promise((r) => { release = r })
      const api = mockApi(routes({ 'POST /api/volumes/sizes': async () => { await gate; return answer(202, { queued: true }) } }))
      page()
      const b = await button()
      await waitFor(() => expect(b).toBeEnabled())
      await userEvent.click(b)
      expect(await screen.findByRole('button', { name: 'Measuring…' })).toBeDisabled()
      await userEvent.click(screen.getByRole('button', { name: 'Measuring…' }))
      release()
      await waitFor(() => expect(api.called('POST', '/api/volumes/sizes')).toHaveLength(1))
    })

    test('until it knows whether a measurement is already running the button is off', async () => {
      let release
      const gate = new Promise((r) => { release = r })
      mockApi(routes({ 'GET /api/volumes/sizes': async () => { await gate; return IDLE } }))
      page()
      const b = await button()
      expect(b).toBeDisabled()
      release()
      await waitFor(() => expect(b).toBeEnabled())
    })

    test('when it finishes the figures are read again and it says so', async () => {
      let state = { ...IDLE, measuring: true }
      let measured = false
      const api = mockApi(routes({
        'GET /api/volumes/sizes': () => state,
        'GET /api/storage': () => storage(measured ? vol() : {}),
      }))
      page()
      expect(await screen.findByRole('button', { name: 'Measuring…' })).toBeDisabled()
      state = { ...IDLE, finishedAt: new Date().toISOString(), measured: 2 }
      measured = true
      await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Volume sizes measured'), { timeout: 5000 })
      expect(within(await row()).getByText('12.0 MB')).toBeInTheDocument()
      expect(api.called('GET', '/api/storage').length).toBeGreaterThan(1)
    })

    test('a measurement that failed says why, in the page and in a message', async () => {
      let state = { ...IDLE, measuring: true }
      mockApi(routes({ 'GET /api/volumes/sizes': () => state }))
      page()
      await screen.findByRole('button', { name: 'Measuring…' })
      state = { ...IDLE, finishedAt: new Date().toISOString(), error: 'Docker could not measure the volumes' }
      await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Docker could not measure the volumes'), { timeout: 5000 })
      expect(await screen.findByText('Could not measure: Docker could not measure the volumes')).toBeInTheDocument()
      expect(toasts.success).not.toHaveBeenCalledWith('Volume sizes measured')
    })

    test('"already measuring" (another window asked) is not an error: it just shows the measuring state', async () => {
      let measuring = false
      mockApi(routes({ 'GET /api/volumes/sizes': () => ({ ...IDLE, measuring }), 'POST /api/volumes/sizes': () => { measuring = true; return answer(409, { error: 'The sizes are already being measured', code: 'already_measuring' }) } }))
      page()
      await userEvent.click(await button())
      expect(await screen.findByRole('button', { name: 'Measuring…' })).toBeDisabled()
      expect(toasts.error).not.toHaveBeenCalled()
    })

    test('another failure to ask is shown', async () => {
      mockApi(routes({ 'POST /api/volumes/sizes': answer(500, { error: 'boom' }) }))
      page()
      await userEvent.click(await button())
      await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('boom'))
    })

    test('nothing is measured, and no message shown, just by opening the page', async () => {
      const api = mockApi(routes())
      page()
      await screen.findByText('Not measured yet.')
      expect(api.called('POST', '/api/volumes/sizes')).toHaveLength(0)
      expect(toasts.success).not.toHaveBeenCalled()
    })
  })
})

describe('deleting an app\'s output logs', () => {
  const open = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Delete output logs' }))
    return screen.findByRole('alertdialog')
  }

  test('asks first, then deletes that app\'s logs', async () => {
    const api = mockApi(routes({ [`DELETE /api/apps/${APP_ID}/logs`]: { freedBytes: 3 * MB } }))
    page()
    const dialog = await open()
    expect(dialog).toHaveTextContent(/removed for good/)
    expect(api.called('DELETE', `/api/apps/${APP_ID}/logs`)).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.called('DELETE', `/api/apps/${APP_ID}/logs`)).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Deleted the output logs (3.0 MB)'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  test('cancel sends nothing', async () => {
    const api = mockApi(routes())
    page()
    await userEvent.click(within(await open()).getByRole('button', { name: 'Cancel' }))
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  test('a running app\'s refusal is shown', async () => {
    mockApi(routes({ [`DELETE /api/apps/${APP_ID}/logs`]: answer(409, { error: 'The app is running and its output is still being collected; stop it first' }) }))
    page()
    await userEvent.click(within(await open()).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/stop it first/)))
  })

  test('is not offered for an app with no logs', async () => {
    mockApi(routes({ 'GET /api/storage': storage({ logs: { totalBytes: 0, apps: [] } }) }))
    page()
    await screen.findByRole('link', { name: 'My App' })
    expect(screen.queryByRole('button', { name: 'Delete output logs' })).toBeNull()
  })
})

describe('volumes kept without being mounted', () => {
  const kept = [
    makeVolume({ id: 'v1', path: '/old', state: 'detached', appName: 'My App', dockerName: 'shipdok-vol-1' }),
    makeVolume({ id: 'v2', path: '/files', state: 'orphaned', appId: null, appName: 'Shop', dockerName: 'shipdok-vol-2' }),
  ]

  test('says so when there are none', async () => {
    mockApi(routes())
    page()
    expect(await screen.findByText(/no volumes are being kept/i)).toBeInTheDocument()
  })

  test('lists each with where it came from, in plain words', async () => {
    mockApi(routes({ 'GET /api/volumes': { volumes: kept } }))
    page()
    const row = (await screen.findByText('/old')).closest('tr')
    expect(within(row).getByText(/removed from my app/i)).toBeInTheDocument()
    const orphan = screen.getByText('/files').closest('tr')
    expect(within(orphan).getByText(/left behind by the deleted app shop/i)).toBeInTheDocument()
    expect(within(orphan).getByText('shipdok-vol-2')).toBeInTheDocument()
  })

  test('shows the size of each, or that it was not measured', async () => {
    mockApi(routes({ 'GET /api/volumes': { volumes: [
      makeVolume({ id: 'v1', path: '/old', state: 'detached', sizeBytes: 3 * MB, measuredAt: new Date(Date.now() - 2 * 60_000).toISOString() }),
      makeVolume({ id: 'v2', path: '/files', state: 'orphaned', appId: null, appName: 'Shop', dockerName: 'shipdok-vol-2' }),
    ] } }))
    page()
    const measured = (await screen.findByText('/old')).closest('tr')
    expect(within(measured).getByText('3.0 MB')).toBeInTheDocument()
    expect(within(measured).getByText('2 min ago')).toBeInTheDocument()
    expect(within(screen.getByText('/files').closest('tr')).getByText('not measured')).toBeInTheDocument()
  })

  test('deleting one asks first, says it is permanent, and then asks the API', async () => {
    const api = mockApi(routes({ 'GET /api/volumes': { volumes: kept }, 'DELETE /api/volumes/v1': answer(202, { queued: true }) }))
    page()
    const row = (await screen.findByText('/old')).closest('tr')
    await userEvent.click(within(row).getByRole('button', { name: /delete/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/permanent/i)).toBeInTheDocument()
    expect(api.called('DELETE', '/api/volumes/v1')).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete volume' }))
    await waitFor(() => expect(api.called('DELETE', '/api/volumes/v1')).toHaveLength(1))
  })

  test('cancelling sends nothing', async () => {
    const api = mockApi(routes({ 'GET /api/volumes': { volumes: kept } }))
    page()
    const row = (await screen.findByText('/old')).closest('tr')
    await userEvent.click(within(row).getByRole('button', { name: /delete/i }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(api.called('DELETE', '/api/volumes/v1')).toHaveLength(0)
  })

  test('a failed removal shows its reason', async () => {
    mockApi(routes({ 'GET /api/volumes': { volumes: [makeVolume({ id: 'v1', path: '/old', state: 'detached', removeError: 'A container still uses this volume, so it was not removed' })] } }))
    page()
    expect(await screen.findByText(/a container still uses this volume/i)).toBeInTheDocument()
  })
})
