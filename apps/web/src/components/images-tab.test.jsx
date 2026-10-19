import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImagesTab from './images-tab'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { makeApp, makeImages, makeVersion, APP_ID } from '@/test/fixtures'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const IMAGES = `GET /api/apps/${APP_ID}/images`
const PRUNE = `POST /api/apps/${APP_ID}/prune`
const RETENTION = `PUT /api/apps/${APP_ID}/retention`
const sha = (c) => c.repeat(40)
const versions = [
  makeVersion({ deploymentId: 'l', commit: sha('a'), image: 'i:l', state: 'live', bytes: 80_000_000 }),
  makeVersion({ deploymentId: 'p', commit: sha('b'), image: 'i:p', state: 'previous', bytes: 70_000_000, canRollBackTo: true }),
  makeVersion({ deploymentId: 'o1', commit: sha('c'), image: 'i:o1', state: 'prunable', bytes: 60_000_000, canRollBackTo: true }),
  makeVersion({ deploymentId: 'o2', commit: sha('d'), image: 'i:o2', state: 'prunable', bytes: 5_000_000, canRollBackTo: true }),
  makeVersion({ deploymentId: 'g', commit: sha('e'), image: 'i:g', state: 'removed', bytes: 1 }),
]
const tab = () => renderWithProviders(<ImagesTab app={makeApp()} />)

describe('the versions list', () => {
  test('shows each version with its state and size (none for a removed image)', async () => {
    mockApi({ [IMAGES]: makeImages(versions) })
    tab()
    const rows = (await screen.findAllByRole('row')).slice(1)
    expect(rows).toHaveLength(5)
    expect(within(rows[0]).getByText('Live')).toBeInTheDocument()
    expect(within(rows[0]).getByText('76.3 MB')).toBeInTheDocument()
    expect(within(rows[3]).getByText('Old image')).toBeInTheDocument()
    expect(within(rows[4]).getByText('Image removed')).toBeInTheDocument()
    expect(within(rows[4]).getByText('—', { selector: 'td' })).toBeInTheDocument()
  })

  test('no deployments yet', async () => {
    mockApi({ [IMAGES]: makeImages([]) })
    tab()
    expect(await screen.findByText(/no successful deployments yet/i)).toBeInTheDocument()
  })

  test('a load failure can be retried', async () => {
    mockApi({ [IMAGES]: answer(500, { error: 'x' }) })
    tab()
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
  })
})

describe('cleaning up', () => {
  test('shows exactly which images will go before anything is sent', async () => {
    const api = mockApi({ [IMAGES]: makeImages(versions), [PRUNE]: answer(202, { queued: true }) })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: /clean up now/i }))
    const dialog = await screen.findByRole('dialog')
    const items = within(dialog).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('ccccccc')
    expect(items[1]).toHaveTextContent('ddddddd')
    expect(dialog).not.toHaveTextContent('aaaaaaa') // the live and the kept version are not listed
    expect(dialog).not.toHaveTextContent('bbbbbbb')
    expect(dialog).toHaveTextContent(/cannot be undone/i)
    expect(api.called('POST', `/api/apps/${APP_ID}/prune`)).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clean up' }))
    await waitFor(() => expect(api.called('POST', `/api/apps/${APP_ID}/prune`)).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Clean-up queued'))
  })

  test('cancelling the question sends nothing', async () => {
    const api = mockApi({ [IMAGES]: makeImages(versions) })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: /clean up now/i }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.called('POST', `/api/apps/${APP_ID}/prune`)).toHaveLength(0)
  })

  test('with nothing old to remove it says so', async () => {
    mockApi({ [IMAGES]: makeImages(versions.slice(0, 2)) })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: /clean up now/i }))
    expect(await within(await screen.findByRole('dialog')).findByText(/no old versions to remove/i)).toBeInTheDocument()
  })

  test('says what the last clean-up did, including skipped images and problems', async () => {
    const cleanup = { last_run_at: '2026-10-19T11:00:00Z', trigger: 'manual', images_removed: 2, freed_bytes: 3_000_000, skipped: 1, error: 'one failed' }
    mockApi({ [IMAGES]: makeImages(versions, { cleanup }) })
    tab()
    expect(await screen.findByText(/removed 2 images/i)).toHaveTextContent(/freed 2\.9 MB/)
    expect(screen.getByText(/1 skipped because something still uses it/)).toBeInTheDocument()
    expect(screen.getByText(/one failed/)).toBeInTheDocument()
  })

  test('says when none has run', async () => {
    mockApi({ [IMAGES]: makeImages(versions) })
    tab()
    expect(await screen.findByText(/no clean-up has run yet/i)).toBeInTheDocument()
  })

  test('after queueing it shows it is running, and blocks a second request, until the result changes', async () => {
    let cleanup = null
    mockApi({ [IMAGES]: () => makeImages(versions, { cleanup }), [PRUNE]: answer(202, { queued: true }) })
    const { client } = tab()
    await userEvent.click(await screen.findByRole('button', { name: /clean up now/i }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clean up' }))
    expect(await screen.findByText(/clean-up is running/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /clean up now/i })).toBeDisabled()
    cleanup = { last_run_at: '2026-10-19T12:00:00Z', trigger: 'manual', images_removed: 2, freed_bytes: 0, skipped: 0, error: null }
    await client.invalidateQueries({ queryKey: ['images', APP_ID] })
    await waitFor(() => expect(screen.queryByText(/clean-up is running/i)).toBeNull())
    expect(screen.getByRole('button', { name: /clean up now/i })).toBeEnabled()
  })

  test('a refusal is shown', async () => {
    mockApi({ [IMAGES]: makeImages(versions), [PRUNE]: answer(503, { error: 'Job queue unavailable' }) })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: /clean up now/i }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clean up' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Job queue unavailable'))
  })
})

describe('settings for keeping versions', () => {
  test('saves the number of earlier versions to keep', async () => {
    const api = mockApi({ [IMAGES]: makeImages(versions), [RETENTION]: { keep_previous_images: 3, auto_prune: false } })
    tab()
    const input = await screen.findByLabelText(/earlier versions to keep/i)
    expect(input).toHaveValue(1)
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled() // unchanged
    await userEvent.clear(input)
    await userEvent.type(input, '3')
    await userEvent.click(save)
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}/retention`)[0].body).toEqual({ keep_previous_images: 3 }))
  })

  test('refuses numbers outside 0 to 10 and blanks without asking the API', async () => {
    const api = mockApi({ [IMAGES]: makeImages(versions) })
    tab()
    const input = await screen.findByLabelText(/earlier versions to keep/i)
    for (const bad of ['11', '-1', '1.5', '']) {
      await userEvent.clear(input)
      if (bad) await userEvent.type(input, bad)
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
      expect(screen.getByText(/whole number from 0 to 10/i)).toBeInTheDocument()
    }
    for (const ok of ['0', '10']) {
      await userEvent.clear(input)
      await userEvent.type(input, ok)
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    }
    expect(api.called('PUT', `/api/apps/${APP_ID}/retention`)).toHaveLength(0)
  })

  test('the automatic clean-up switch reflects and changes the setting', async () => {
    const api = mockApi({ [IMAGES]: makeImages(versions, { auto_prune: true }), [RETENTION]: { keep_previous_images: 1, auto_prune: false } })
    tab()
    const sw = await screen.findByRole('switch', { name: /clean up automatically/i })
    expect(sw).toBeChecked()
    await userEvent.click(sw)
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}/retention`)[0].body).toEqual({ auto_prune: false }))
  })

  test('says logs are never removed by a clean-up', async () => {
    mockApi({ [IMAGES]: makeImages(versions) })
    tab()
    expect(await screen.findByText(/logs are never removed/i)).toBeInTheDocument()
  })
})
