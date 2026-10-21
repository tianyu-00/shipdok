import { describe, test, expect } from 'vitest'
import { runningSetting, settingsChanges, settingsProblems, settingsToForm, SETTING_LABELS } from './settings'
import { makeApp } from '@/test/fixtures'

const app = makeApp()
const form = (over = {}) => ({ ...settingsToForm(app), ...over })

describe('settingsToForm', () => {
  test('turns an app into text values (a missing health path is an empty box, cpus lose their trailing zeros)', () => {
    expect(settingsToForm(makeApp({ health_path: null, cpus: '1.50' }))).toMatchObject({ health_path: '', cpus: '1.5', host_port: '8080', max_restarts: '5' })
  })
})

describe('the build time limit', () => {
  test('is an empty box for no limit, and the number otherwise', () => {
    expect(settingsToForm(makeApp({ build_timeout_minutes: null })).build_timeout_minutes).toBe('')
    expect(settingsToForm(makeApp({ build_timeout_minutes: 45 })).build_timeout_minutes).toBe('45')
  })
  test.each(['', '5', '45', '10080'])('%j is allowed', (v) => expect(settingsProblems(form({ build_timeout_minutes: v })).build_timeout_minutes).toBeUndefined())
  test.each(['4', '0', '10081', '2.5', 'abc', '-5'])('%j is flagged', (v) => expect(settingsProblems(form({ build_timeout_minutes: v })).build_timeout_minutes).toEqual(expect.any(String)))
  test('changes: nothing when the same, a number when set, null when cleared', () => {
    expect(settingsChanges(form({ build_timeout_minutes: '' }), makeApp({ build_timeout_minutes: null }))).toEqual({})
    expect(settingsChanges(form({ build_timeout_minutes: '60' }), makeApp({ build_timeout_minutes: null }))).toEqual({ build_timeout_minutes: 60 })
    expect(settingsChanges(form({ build_timeout_minutes: '45' }), makeApp({ build_timeout_minutes: 45 }))).toEqual({})
    expect(settingsChanges(form({ build_timeout_minutes: '' }), makeApp({ build_timeout_minutes: 45 }))).toEqual({ build_timeout_minutes: null })
  })
  test('has a name for the "waiting for the next deployment" list', () => expect(SETTING_LABELS.build_timeout_minutes).toBe('Build time limit'))
  test('persistent storage has one too', () => expect(SETTING_LABELS.volumes).toBe('Persistent storage'))
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

describe('the build method and its commands', () => {
  const rp = { build_method: 'railpack', install_command: '', build_command: '', start_command: '' }

  test('the form starts from the app (an app from before this existed counts as the Dockerfile, with no commands)', () => {
    expect(settingsToForm(makeApp({ build_method: 'railpack', install_command: 'npm ci', build_command: null }))).toMatchObject({ build_method: 'railpack', install_command: 'npm ci', build_command: '', start_command: '' })
    const old = makeApp(); delete old.build_method; delete old.install_command
    expect(settingsToForm(old)).toMatchObject({ build_method: 'dockerfile', install_command: '' })
  })

  test('only what differs is sent; an emptied command is null; spaces around a command do not count', () => {
    const app = makeApp({ build_method: 'railpack', install_command: 'npm ci', start_command: 'node s.js' })
    const f = { ...settingsToForm(app) }
    expect(settingsChanges(f, app)).toEqual({})
    expect(settingsChanges({ ...f, install_command: ' npm ci ' }, app)).toEqual({})
    expect(settingsChanges({ ...f, install_command: '' }, app)).toEqual({ install_command: null })
    expect(settingsChanges({ ...f, build_command: ' npm run b' }, app)).toEqual({ build_command: 'npm run b' })
    expect(settingsChanges({ ...f, build_method: 'dockerfile' }, app)).toEqual({ build_method: 'dockerfile' })
  })

  test('a command is checked only for a Railpack app, and only for length and line breaks', () => {
    expect(settingsProblems(form({ ...rp, start_command: 'x'.repeat(1000) })).start_command).toBeUndefined()
    expect(settingsProblems(form({ ...rp, start_command: 'x'.repeat(1001) })).start_command).toBe('At most 1000 characters')
    expect(settingsProblems(form({ ...rp, build_command: 'a\nb' })).build_command).toEqual(expect.any(String))
    expect(settingsProblems(form({ ...rp, install_command: '' })).install_command).toBeUndefined()
    expect(settingsProblems(form({ ...rp, build_method: 'dockerfile', start_command: 'x'.repeat(2000) })).start_command).toBeUndefined()
  })

  test('the pending list names them', () => {
    expect(SETTING_LABELS).toMatchObject({ build_method: 'Build method', install_command: 'Install command', build_command: 'Build command', start_command: 'Start command' })
  })
})
