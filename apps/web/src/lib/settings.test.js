import { describe, test, expect } from 'vitest'
import { runningSetting, settingsChanges, settingsProblems, settingsToForm } from './settings'
import { makeApp } from '@/test/fixtures'

const app = makeApp()
const form = (over = {}) => ({ ...settingsToForm(app), ...over })

describe('settingsToForm', () => {
  test('turns an app into text values (a missing health path is an empty box, cpus lose their trailing zeros)', () => {
    expect(settingsToForm(makeApp({ health_path: null, cpus: '1.50' }))).toMatchObject({ health_path: '', cpus: '1.5', host_port: '8080', max_restarts: '5' })
  })
})

describe('settingsProblems', () => {
  test('the app as it is has none', () => expect(settingsProblems(form())).toEqual({}))
  test.each([
    ['name', { name: '  ' }], ['name', { name: '!!!' }], ['branch', { branch: '' }], ['branch', { branch: '..x' }],
    ['root_dir', { root_dir: '' }], ['root_dir', { root_dir: '../x' }], ['root_dir', { root_dir: '/abs' }],
    ['container_port', { container_port: '0' }], ['container_port', { container_port: '65536' }], ['container_port', { container_port: 'abc' }], ['container_port', { container_port: '' }],
    ['host_port', { host_port: '1023' }], ['host_port', { host_port: '65536' }], ['host_port', { host_port: '80.5' }], ['host_port', { host_port: '' }],
    ['health_path', { health_path: 'health' }], ['health_path', { health_path: '/a b' }],
    ['memory_mb', { memory_mb: '63' }], ['memory_mb', { memory_mb: '8193' }], ['memory_mb', { memory_mb: '' }],
    ['cpus', { cpus: '0.09' }], ['cpus', { cpus: '4.1' }], ['cpus', { cpus: 'x' }],
    ['max_restarts', { max_restarts: '51' }], ['max_restarts', { max_restarts: '-1' }], ['max_restarts', { max_restarts: '' }],
  ])('flags %s for %j', (field, over) => expect(settingsProblems(form(over))[field]).toEqual(expect.any(String)))
  test.each([
    { host_port: '1024' }, { host_port: '65535' }, { container_port: '1' }, { memory_mb: '64' }, { memory_mb: '8192' }, { cpus: '0.1' }, { cpus: '4' },
    { max_restarts: '0' }, { max_restarts: '50' }, { health_path: '' }, { health_path: '/' }, { root_dir: '.' }, { root_dir: 'web/app' },
  ])('accepts the edge %j', (over) => expect(settingsProblems(form(over))).toEqual({}))
})

describe('settingsChanges', () => {
  test('nothing changed, nothing to send (also when only spaces or number formatting differ)', () => {
    expect(settingsChanges(form(), app)).toEqual({})
    expect(settingsChanges(form({ name: ' My App ', cpus: '1.0', memory_mb: '512' }), app)).toEqual({})
  })
  test('only what differs, with numbers as numbers', () => {
    expect(settingsChanges(form({ host_port: '9000', memory_mb: '1024', cpus: '2', branch: 'dev', name: 'New', root_dir: 'web', container_port: '4000', max_restarts: '0' }), app))
      .toEqual({ host_port: 9000, memory_mb: 1024, cpus: 2, branch: 'dev', name: 'New', root_dir: 'web', container_port: 4000, max_restarts: 0 })
  })
  test('an emptied health path means "none" (null); a changed one is sent as text', () => {
    expect(settingsChanges(form({ health_path: '' }), app)).toEqual({ health_path: null })
    expect(settingsChanges(form({ health_path: ' /up ' }), app)).toEqual({ health_path: '/up' })
  })
  test('adding a health path to an app that had none', () => {
    expect(settingsChanges(form({ health_path: '/h' }), makeApp({ health_path: null }))).toEqual({ health_path: '/h' })
  })
})

describe('runningSetting', () => {
  test('uses what the running version has, not the edited value', () => {
    const edited = makeApp({ host_port: 9000, running_settings: { host_port: 8080, health_path: null } })
    expect(runningSetting(edited, 'host_port')).toBe(8080)
    expect(runningSetting(edited, 'health_path')).toBeNull() // "no health check" is a real answer, not "missing"
  })
  test('falls back to the app when nothing has run or the record lacks the key', () => {
    expect(runningSetting(makeApp({ host_port: 9000 }), 'host_port')).toBe(9000)
    expect(runningSetting(makeApp({ memory_mb: 256, running_settings: {} }), 'memory_mb')).toBe(256)
  })
})
