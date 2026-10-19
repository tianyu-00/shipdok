import { describe, test, expect } from 'vitest'
import { displayState, timeAgo, formatDuration, formatBytes, shortSha, deploymentReason, parseLogLine, isActiveDeployment, DEPLOYMENT_STATUS, RUNTIME_STATE } from './format'

const NOW = Date.parse('2026-10-19T12:00:00Z')

describe('timeAgo', () => {
  test.each([
    ['2026-10-19T11:59:58Z', 'just now'], ['2026-10-19T11:59:30Z', '30s ago'], ['2026-10-19T11:55:00Z', '5 min ago'],
    ['2026-10-19T09:00:00Z', '3 h ago'], ['2026-10-16T12:00:00Z', '3 days ago'],
  ])('%s -> %s', (when, text) => expect(timeAgo(when, NOW)).toBe(text))
  test('nothing or nonsense is a dash', () => {
    expect(timeAgo(null, NOW)).toBe('—')
    expect(timeAgo('garbage', NOW)).toBe('—')
  })
})

describe('formatDuration', () => {
  test('seconds, minutes, hours', () => {
    expect(formatDuration('2026-10-19T12:00:00Z', '2026-10-19T12:00:42Z')).toBe('42s')
    expect(formatDuration('2026-10-19T12:00:00Z', '2026-10-19T12:03:05Z')).toBe('3m 5s')
    expect(formatDuration('2026-10-19T12:00:00Z', '2026-10-19T14:10:00Z')).toBe('2h 10m')
  })
  test('unfinished is a dash, and a clock that went backwards is 0s', () => {
    expect(formatDuration('2026-10-19T12:00:00Z', null)).toBe('—')
    expect(formatDuration('2026-10-19T12:00:10Z', '2026-10-19T12:00:00Z')).toBe('0s')
  })
})

describe('formatBytes', () => {
  test.each([[0, '0 B'], [1023, '1023 B'], [1024, '1.0 KB'], [1536, '1.5 KB'], [5 * 1024 ** 2, '5.0 MB'], [250 * 1024 ** 2, '250 MB'], [3 * 1024 ** 3, '3.0 GB']])('%s -> %s', (n, s) => expect(formatBytes(n)).toBe(s))
  test('missing is a dash', () => { expect(formatBytes(null)).toBe('—'); expect(formatBytes(undefined)).toBe('—') })
})

test('shortSha', () => { expect(shortSha('a'.repeat(40))).toBe('aaaaaaa'); expect(shortSha(null)).toBe('—') })

describe('statuses', () => {
  test('every deployment status of the API has a label, and only the unfinished ones are active', () => {
    for (const s of ['queued', 'building', 'starting', 'validating', 'successful', 'failed', 'cancelled', 'superseded', 'interrupted']) {
      expect(DEPLOYMENT_STATUS[s].label).toBeTruthy()
    }
    expect(['queued', 'building', 'starting', 'validating'].every(isActiveDeployment)).toBe(true)
    expect(['successful', 'failed', 'cancelled', 'superseded', 'interrupted'].some(isActiveDeployment)).toBe(false)
    expect(isActiveDeployment('nonsense')).toBe(false)
  })
  test('every runtime state has a label', () => {
    for (const s of ['running', 'stopped', 'unhealthy', 'restarting', 'crashed']) expect(RUNTIME_STATE[s].label).toBeTruthy()
  })
})

describe('deploymentReason', () => {
  test('the stored summary wins', () => expect(deploymentReason({ status: 'failed', error_summary: 'docker exited 1' })).toBe('docker exited 1'))
  test('cancelled and superseded explain themselves', () => {
    expect(deploymentReason({ status: 'cancelled' })).toMatch(/cancelled/i)
    expect(deploymentReason({ status: 'superseded' })).toMatch(/newer deployment/i)
  })
  test('a success needs no explanation', () => expect(deploymentReason({ status: 'successful' })).toBeNull())
})

describe('parseLogLine', () => {
  test('splits time, stream and message', () => {
    expect(parseLogLine('2026-10-19T12:00:01.000Z stderr boom: it broke')).toEqual({ time: '2026-10-19T12:00:01.000Z', stream: 'stderr', message: 'boom: it broke' })
  })
  test('an empty message is fine', () => expect(parseLogLine('2026-10-19T12:00:01.000Z stdout ').message).toBe(''))
  test('a line in some other format is shown as it is', () => expect(parseLogLine('plain text')).toEqual({ time: null, stream: 'stdout', message: 'plain text' }))
})

describe('displayState', () => {
  const app = (desired, state) => ({ desired_state: desired, runtime: state === undefined ? null : { state } })
  test('what the worker reports, when it matches what was asked', () => {
    expect(displayState(app('running', 'running'))).toBe('running')
    expect(displayState(app('stopped', 'stopped'))).toBe('stopped')
    expect(displayState(app('running', 'crashed'))).toBe('crashed')
    expect(displayState(app('running', 'unhealthy'))).toBe('unhealthy')
  })
  test('a Stop that has not happened yet is "stopping"', () => {
    for (const state of ['running', 'unhealthy', 'restarting']) expect(displayState(app('stopped', state))).toBe('stopping')
  })
  test('a Start that has not happened yet is "starting"', () => {
    expect(displayState(app('running', 'stopped'))).toBe('starting')
  })
  test('an app the worker has not reported on is not "starting"', () => {
    expect(displayState(app('running', undefined))).toBeUndefined()
  })
  test('a stopped app that crashed earlier stays crashed (the administrator can see why)', () => {
    expect(displayState(app('stopped', 'crashed'))).toBe('crashed')
  })
})

describe('appAddress', () => {
  test('points at the port the running version answers on, not an edited one', async () => {
    const { appAddress } = await import('./format')
    expect(appAddress({ host_port: 9000, running_settings: { host_port: 8080 } }, 'pi.local')).toBe('http://pi.local:8080')
    expect(appAddress({ host_port: 9000, running_settings: null }, 'pi.local')).toBe('http://pi.local:9000')
  })
})
