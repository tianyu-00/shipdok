import { describe, test, expect } from 'vitest'
import { chartPoints, cpuCeiling, cpuTicks, formatCpu, formatMemory, memoryPercent, memoryTicks } from './stats'

const MB = 1024 * 1024

describe('formatCpu', () => {
  test.each([[0, '0.0%'], [3.5, '3.5%'], [12.34, '12.3%'], [99.94, '99.9%'], [100, '100%'], [187.6, '188%'], [250, '250%']])('%s -> %s', (v, text) => expect(formatCpu(v)).toBe(text))
  test.each([[null], [undefined], [NaN]])('unknown (%s) is a dash, never 0%', (v) => expect(formatCpu(v)).toBe('—'))
})

describe('formatMemory', () => {
  test('used and limit', () => expect(formatMemory({ memoryBytes: 180 * MB, memoryLimitBytes: 512 * MB })).toBe('180 MB of 512 MB'))
  test('no limit: only what is used', () => expect(formatMemory({ memoryBytes: 180 * MB, memoryLimitBytes: null })).toBe('180 MB'))
  test('nothing known', () => expect(formatMemory(null)).toBe('—'))
  test('zero is zero, not a dash', () => expect(formatMemory({ memoryBytes: 0, memoryLimitBytes: null })).toBe('0 B'))
})

describe('memoryPercent', () => {
  test('a whole percent of the limit', () => expect(memoryPercent({ memoryBytes: 128 * MB, memoryLimitBytes: 512 * MB })).toBe(25))
  test('never above 100', () => expect(memoryPercent({ memoryBytes: 600 * MB, memoryLimitBytes: 512 * MB })).toBe(100))
  test('null without a limit or without stats', () => {
    expect(memoryPercent({ memoryBytes: 5, memoryLimitBytes: null })).toBeNull()
    expect(memoryPercent(null)).toBeNull()
  })
})

describe('chartPoints', () => {
  test('time in milliseconds, memory in MB to one decimal, CPU kept (null stays null)', () => {
    const pts = chartPoints([{ t: '2026-10-19T12:00:00.000Z', cpu: 2.5, memory: 100 * MB }, { t: '2026-10-19T12:00:15.000Z', cpu: null, memory: 100.26 * MB }])
    expect(pts).toEqual([
      { time: Date.parse('2026-10-19T12:00:00.000Z'), cpu: 2.5, memory: 100 },
      { time: Date.parse('2026-10-19T12:00:15.000Z'), cpu: null, memory: 100.3 },
    ])
  })
  test('nothing in, nothing out', () => {
    expect(chartPoints([])).toEqual([])
    expect(chartPoints(undefined)).toEqual([])
  })
})

describe('cpuCeiling', () => {
  test('at least one full cpu, so a quiet app does not look busy', () => expect(cpuCeiling([{ cpu: 2 }, { cpu: null }])).toBe(100))
  test('higher (in steps of 50) when the app used more than one cpu', () => {
    expect(cpuCeiling([{ cpu: 101 }])).toBe(150)
    expect(cpuCeiling([{ cpu: 150 }])).toBe(150)
    expect(cpuCeiling([{ cpu: 230 }])).toBe(250)
  })
  test('no data', () => expect(cpuCeiling([])).toBe(100))
})

describe('axis marks', () => {
  test('cpu: every 50 up to 200, then every 100', () => {
    expect(cpuTicks(100)).toEqual([0, 50, 100])
    expect(cpuTicks(150)).toEqual([0, 50, 100, 150])
    expect(cpuTicks(200)).toEqual([0, 50, 100, 150, 200])
    expect(cpuTicks(300)).toEqual([0, 100, 200, 300])
  })
  test('memory: 0, the middle and the limit; automatic without a limit', () => {
    expect(memoryTicks(512)).toEqual([0, 256, 512])
    expect(memoryTicks(null)).toBeUndefined()
  })
})
