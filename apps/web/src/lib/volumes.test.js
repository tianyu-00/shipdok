import { describe, test, expect } from 'vitest'
import { normalizeVolumePath, volumePathsProblem, codeFolderWarning, MAX_VOLUMES } from './volumes'

describe('one path', () => {
  test.each([['/data', '/data'], ['//data/', '/data'], ['/app//uploads/', '/app/uploads'], ['  /x/y  ', '/x/y'], ['/a.b-c_d', '/a.b-c_d']])('%j becomes %j', (input, path) => {
    expect(normalizeVolumePath(input)).toEqual({ path })
  })
  test.each([
    [''], ['data'], ['/'], ['///'], ['/proc'], ['/proc/self'], ['/sys'], ['/dev/shm'], ['/a/../b'], ['/a/./b'], ['/my data'], ['/da$ta'], [`/${'a'.repeat(250)}`],
  ])('%j is refused with a reason', (input) => {
    expect(normalizeVolumePath(input).error).toEqual(expect.any(String))
  })
  test('/process and /system are fine (only /proc, /sys and /dev themselves are not)', () => {
    expect(normalizeVolumePath('/process').path).toBe('/process')
    expect(normalizeVolumePath('/system').path).toBe('/system')
  })
})

describe('the list', () => {
  test('a good list has no problem, an empty one is fine (it detaches everything)', () => {
    expect(volumePathsProblem(['/data', '/app/uploads'])).toBeNull()
    expect(volumePathsProblem([])).toBeNull()
  })
  test('twice, nested and too many are caught', () => {
    expect(volumePathsProblem(['/data', '/data/'])).toMatch(/twice/)
    expect(volumePathsProblem(['/data', '/data/sub'])).toMatch(/inside/)
    expect(volumePathsProblem(Array.from({ length: MAX_VOLUMES + 1 }, (_, i) => `/v${i}`))).toMatch(/at most 10/)
  })
  test('the first bad path is named', () => expect(volumePathsProblem(['/ok', 'relative'])).toMatch(/relative/))
})

describe('the code folder warning', () => {
  test.each(['/app', '/usr/src/app', '/home/node/app', '/code', '/workspace', '/srv', '/var/www/html', '/usr/share/nginx/html'])('%s is probably where the code lives', (path) => {
    expect(codeFolderWarning(path)).toMatch(/probably the folder your app's code lives in/)
  })
  test('it is a warning about the exact folder only: a data folder inside it, or any other path, is fine', () => {
    for (const path of ['/app/data', '/app/uploads', '/data', '/var/lib/db', '/usr/src/app/data', '/application']) expect(codeFolderWarning(path)).toBeNull()
  })
  test('a doubled or trailing slash does not hide it', () => {
    expect(codeFolderWarning('/app/')).not.toBeNull()
    expect(codeFolderWarning('//app')).not.toBeNull()
  })
  test('what it suggests instead is a data folder', () => expect(codeFolderWarning('/app')).toMatch(/\/app\/data|\/data/))
  test('it never blocks: the same path is still a valid one', () => expect(normalizeVolumePath('/app')).toEqual({ path: '/app' }))
})
