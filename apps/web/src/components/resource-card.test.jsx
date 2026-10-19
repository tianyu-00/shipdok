import { describe, test, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import ResourceCard from './resource-card'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { makeApp, APP_ID } from '@/test/fixtures'

const MB = 1024 * 1024
const STATS = `GET /api/apps/${APP_ID}/stats`
const sample = (i, cpu = 5, mem = 100) => ({ t: new Date(Date.parse('2026-10-19T12:00:00Z') + i * 15_000).toISOString(), cpu, memory: mem * MB })
const latest = (over = {}) => ({ cpuPercent: 12.5, memoryBytes: 180 * MB, memoryLimitBytes: 512 * MB, sampledAt: '2026-10-19T12:01:00Z', ...over })
const card = () => renderWithProviders(<ResourceCard app={makeApp()} />)

describe('the resource card', () => {
  test('shows the current CPU and memory, and how much of the limit is used', async () => {
    mockApi({ [STATS]: { latest: latest(), samples: [sample(0), sample(1), sample(2)] } })
    card()
    expect(await screen.findByText('12.5%')).toBeInTheDocument()
    expect(screen.getByText('180 MB of 512 MB')).toBeInTheDocument()
    expect(screen.getByText('35% of its limit')).toBeInTheDocument()
  })

  test('draws both charts (with a name for screen readers) once there are a few measurements', async () => {
    mockApi({ [STATS]: { latest: latest(), samples: [sample(0), sample(1), sample(2)] } })
    card()
    expect(await screen.findByRole('img', { name: 'CPU use over the last hour' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Memory use over the last hour' })).toBeInTheDocument()
  })

  test('with fewer than two measurements it says so instead of drawing an empty chart', async () => {
    mockApi({ [STATS]: { latest: latest(), samples: [sample(0)] } })
    card()
    expect(await screen.findByText(/charts appear once a few measurements are in/i)).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
  })

  test('an app that is not running: dashes, and no measurements', async () => {
    mockApi({ [STATS]: { latest: null, samples: [] } })
    card()
    expect(await screen.findByText(/no measurements in the last hour/i)).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.getByText('Shown while the app is running.')).toBeInTheDocument()
  })

  test('a stopped app still shows the chart of what it did before, but no "now" figures', async () => {
    mockApi({ [STATS]: { latest: null, samples: [sample(0), sample(1)] } })
    card()
    expect(await screen.findByRole('img', { name: 'CPU use over the last hour' })).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  test('no limit: no percentage, just the memory used', async () => {
    mockApi({ [STATS]: { latest: latest({ memoryLimitBytes: null }), samples: [] } })
    card()
    expect(await screen.findByText('180 MB')).toBeInTheDocument()
    expect(screen.queryByText(/of its limit/)).toBeNull()
  })

  test('CPU that Docker could not measure is a dash, not 0%', async () => {
    mockApi({ [STATS]: { latest: latest({ cpuPercent: null }), samples: [] } })
    card()
    await screen.findByText('180 MB of 512 MB')
    expect(screen.queryByText('0.0%')).toBeNull()
    expect(screen.getAllByText('—')).toHaveLength(1)
  })

  test('a load failure can be retried', async () => {
    mockApi({ [STATS]: answer(500, { error: 'x' }) })
    card()
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  test('says it is loading before the first answer', async () => {
    mockApi({ [STATS]: () => new Promise(() => {}) })
    card()
    expect(await screen.findByRole('status')).toHaveTextContent('Loading…')
    await waitFor(() => expect(screen.getAllByText('—').length).toBe(2))
  })
})
