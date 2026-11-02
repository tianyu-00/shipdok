import { describe, test, expect, vi, afterEach } from 'vitest'
import { keptBackups, pageOf, parseRestoreKeep, savedRestorePageSize, saveRestorePageSize, RESTORE_MODES, isAppRestoring, restoreModeLabel, downloadBackup, filenameFrom, isAppBusy, isBusy, keepChoices, latestBackups, localHourText, platformBackups, scheduleText, utcHourText, volumeBackups, volumesText, WEEKDAYS } from './backups'
import { ApiError } from './api'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('times', () => {
  test('an hour in UTC reads as 00:00 to 23:00 UTC', () => {
    expect(utcHourText(3)).toBe('03:00 UTC')
    expect(utcHourText(0)).toBe('00:00 UTC')
    expect(utcHourText(23)).toBe('23:00 UTC')
  })
  test('the same hour on this computer\'s clock follows its time zone', () => {
    const now = new Date('2026-10-22T10:00:00Z')
    const offsetHours = -new Date(Date.UTC(2026, 9, 22, 3)).getTimezoneOffset() / 60
    const expected = (h) => String(((h + offsetHours) % 24 + 24) % 24).padStart(2, '0')
    for (const h of [0, 3, 12, 23]) expect(localHourText(h, now).slice(0, 2)).toBe(expected(h))
    expect(localHourText(3, now)).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe('the schedule in words', () => {
  const base = { hour: 3, weekday: 1, keep: 7 }
  test('off says so', () => expect(scheduleText({ ...base, frequency: 'off' })).toBe('No automatic backups'))
  test('daily gives the hour in UTC and on the local clock, and how many are kept', () => {
    const t = scheduleText({ ...base, frequency: 'daily' })
    expect(t).toMatch(/^Every day at 03:00 UTC \(\d{2}:\d{2} on your clock today\), keeping the newest 7$/)
  })
  test('weekly names the day', () => {
    expect(scheduleText({ ...base, frequency: 'weekly', weekday: 0, keep: 3 })).toMatch(/^Every Sunday at 03:00 UTC .*keeping the newest 3$/)
    expect(WEEKDAYS).toHaveLength(7)
    expect(WEEKDAYS[0]).toBe('Sunday')
  })
})

describe('the list', () => {
  const b = (status, over = {}) => ({ id: status, status, ...over })
  test('busy while one is waiting or running', () => {
    expect(isBusy([b('ok'), b('queued')])).toBe(true)
    expect(isBusy([b('running')])).toBe(true)
    expect(isBusy([b('ok'), b('failed')])).toBe(false)
    expect(isBusy([])).toBe(false)
    expect(isBusy(undefined)).toBe(false)
  })
  test('the newest backup that worked, and the newest of all', () => {
    const list = [b('failed', { id: 'f' }), b('ok', { id: 'a' }), b('ok', { id: 'b' })]
    expect(latestBackups(list)).toEqual({ good: list[1], newest: list[0] })
    expect(latestBackups([])).toEqual({ good: null, newest: null })
    expect(latestBackups(undefined)).toEqual({ good: null, newest: null })
    expect(latestBackups([b('failed')]).good).toBeNull()
  })
})

describe('the file name', () => {
  test('is taken from the Content-Disposition header', () => {
    expect(filenameFrom('attachment; filename="shipdok-backup-20261022-030405-12345678.tar.enc"')).toBe('shipdok-backup-20261022-030405-12345678.tar.enc')
  })
  test('a missing or odd header gives a plain name, never a path', () => {
    expect(filenameFrom(undefined)).toBe('shipdok-backup.tar')
    expect(filenameFrom('attachment')).toBe('shipdok-backup.tar')
    expect(filenameFrom('attachment; filename="../../etc/passwd"')).toBe('shipdok-backup.tar')
    expect(filenameFrom('attachment; filename="a\\b"')).toBe('shipdok-backup.tar')
  })
})

describe('downloading', () => {
  const answer = (over = {}) => ({ ok: true, status: 200, blob: async () => new Blob(['data']), headers: { get: (h) => (h === 'Content-Disposition' ? 'attachment; filename="b.tar"' : null) }, json: async () => ({}), ...over })
  const spyDom = () => {
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const clicked = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { clicked.push({ href: this.href, download: this.download }) })
    return clicked
  }
  test('posts the password in the body (never in the address) and hands the file to the browser under its own name', async () => {
    const clicked = spyDom()
    const fetch = vi.fn(async () => answer())
    vi.stubGlobal('fetch', fetch)
    await downloadBackup('abc', 'my-password')
    expect(fetch).toHaveBeenCalledWith('/api/backups/abc/download', expect.objectContaining({ method: 'POST', body: JSON.stringify({ password: 'my-password' }), credentials: 'same-origin' }))
    expect(fetch.mock.calls[0][0]).not.toContain('my-password')
    expect(clicked).toEqual([{ href: 'blob:x', download: 'b.tar' }])
    expect(document.querySelector('a[download]')).toBeNull() // the link is removed again
  })
  test('the temporary address of the file is let go after a while, not at once (the browser may still be reading it)', async () => {
    vi.useFakeTimers()
    try {
      spyDom()
      vi.stubGlobal('fetch', vi.fn(async () => answer()))
      await downloadBackup('abc', 'pw')
      expect(URL.revokeObjectURL).not.toHaveBeenCalled()
      vi.advanceTimersByTime(9000)
      expect(URL.revokeObjectURL).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2000)
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
    } finally { vi.useRealTimers() }
  })
  test('a refusal is an ApiError with the server\'s reason and status, and nothing is downloaded', async () => {
    const clicked = spyDom()
    vi.stubGlobal('fetch', vi.fn(async () => answer({ ok: false, status: 403, json: async () => ({ error: 'The current password is not correct' }) })))
    await expect(downloadBackup('abc', 'x')).rejects.toMatchObject({ name: 'ApiError', status: 403, message: 'The current password is not correct' })
    expect(clicked).toEqual([])
  })
  test('a refusal without a body still says something', async () => {
    spyDom()
    vi.stubGlobal('fetch', vi.fn(async () => answer({ ok: false, status: 500, json: async () => { throw new Error('no body') } })))
    await expect(downloadBackup('abc', 'x')).rejects.toMatchObject({ status: 500, message: 'The download failed (500)' })
  })
  test('an unreachable server is said plainly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network') }))
    await expect(downloadBackup('abc', 'x')).rejects.toBeInstanceOf(ApiError)
    await expect(downloadBackup('abc', 'x')).rejects.toMatchObject({ status: 0 })
  })
})

describe('the two kinds of backup', () => {
  const list = [{ id: 'p', status: 'ok' }, { id: 'p2', kind: 'platform', status: 'ok' }, { id: 'v', kind: 'volumes', appId: 'a1', status: 'running' }, { id: 'v2', kind: 'volumes', appId: 'a2', status: 'ok' }]
  test('a backup without a kind is Shipdok\'s own', () => {
    expect(platformBackups(list).map((b) => b.id)).toEqual(['p', 'p2'])
    expect(volumeBackups(list).map((b) => b.id)).toEqual(['v', 'v2'])
    expect(platformBackups(undefined)).toEqual([])
    expect(volumeBackups(null)).toEqual([])
  })
  test('busy is asked of one app at a time, and a Shipdok backup never makes an app busy', () => {
    expect(isAppBusy(list, 'a1')).toBe(true)
    expect(isAppBusy(list, 'a2')).toBe(false)
    expect(isAppBusy([{ id: 'p', status: 'queued' }], 'a1')).toBe(false)
    expect(isBusy(platformBackups(list))).toBe(false)
  })
  test('the numbers to keep offer the usual choices, plus the app\'s own when it is another', () => {
    expect(keepChoices(3)).toEqual([1, 2, 3, 5, 7, 10, 14, 30, 60])
    expect(keepChoices(4)).toEqual([1, 2, 3, 4, 5, 7, 10, 14, 30, 60])
    expect(keepChoices(61)).toEqual([1, 2, 3, 5, 7, 10, 14, 30, 60, 61])
  })
  test('volumes are counted in words', () => {
    expect([volumesText(0), volumesText(1), volumesText(2)]).toEqual(['0 volumes', '1 volume', '2 volumes'])
  })
})

describe('restoring', () => {
  test('a restore of an app that waits or runs blocks that app only', () => {
    const list = [{ appId: 'a1', status: 'running' }, { appId: 'a2', status: 'ok' }, { appId: 'a3', status: 'queued' }, { appId: 'a4', status: 'failed' }]
    expect([isAppRestoring(list, 'a1'), isAppRestoring(list, 'a2'), isAppRestoring(list, 'a3'), isAppRestoring(list, 'a4'), isAppRestoring(list, 'zz')]).toEqual([true, false, true, false, false])
    expect(isAppRestoring(undefined, 'a1')).toBe(false)
  })
  test('the modes offered: Replace first (the default), then Add over, then only into empty volumes', () => {
    expect(RESTORE_MODES.map((m) => m.value)).toEqual(['replace', 'add', 'empty'])
    expect(restoreModeLabel('add')).toBe('Add over')
    expect(restoreModeLabel('other')).toBe('other')
  })
})

describe('backups kept without an app', () => {
  const vb = (over) => ({ kind: 'volumes', appId: 'a1', status: 'ok', ...over })
  test('a backup whose app is gone, or has no storage, is kept; one whose app is listed is not', () => {
    const data = { apps: [{ id: 'a1' }], backups: [vb({ id: '1' }), vb({ id: '2', appId: null }), vb({ id: '3', appId: 'a9' }), vb({ id: '4', appId: 'a9', status: 'failed' })] }
    expect(keptBackups(data).map((b) => b.id)).toEqual(['2', '3', '4'])
  })
  test('not Shipdok\'s own, and not one that is waiting or running', () => {
    const data = { apps: [], backups: [{ id: 'p', kind: 'platform', appId: null, status: 'ok' }, vb({ id: 'q', appId: 'a9', status: 'queued' }), vb({ id: 'r', appId: 'a9', status: 'running' })] }
    expect(keptBackups(data)).toEqual([])
  })
  test('copes with nothing at all', () => {
    expect(keptBackups(undefined)).toEqual([])
    expect(keptBackups({})).toEqual([])
  })
})

describe('the history of restores', () => {
  test('pageOf cuts a list into pages, never past either end, and says which page it really is', () => {
    const list = Array.from({ length: 12 }, (_, i) => i)
    expect(pageOf(list, 0, 5)).toEqual({ items: [0, 1, 2, 3, 4], page: 0, pages: 3 })
    expect(pageOf(list, 2, 5)).toEqual({ items: [10, 11], page: 2, pages: 3 })
    expect(pageOf(list, 9, 5).page).toBe(2)
    expect(pageOf(list, -4, 5).page).toBe(0)
    expect(pageOf([], 3, 5)).toEqual({ items: [], page: 0, pages: 1 })
    expect(pageOf(list, 0, 12).pages).toBe(1)
    expect(pageOf(list, 0, 11).pages).toBe(2)
  })
  test('parseRestoreKeep: empty is all, a whole number from 1 to a million is itself, anything else is not a number', () => {
    expect(parseRestoreKeep('')).toBeNull()
    expect(parseRestoreKeep('  ')).toBeNull()
    expect(parseRestoreKeep('1')).toBe(1)
    expect(parseRestoreKeep(' 42 ')).toBe(42)
    expect(parseRestoreKeep('1000000')).toBe(1_000_000)
    for (const bad of ['0', '00', '-1', '1.5', '1e3', 'ten', '1000001', '5 6']) expect(parseRestoreKeep(bad)).toBeUndefined()
  })
  test('the page size is 5 unless this browser saved one of the choices; storage that fails is only a convenience', () => {
    localStorage.clear()
    expect(savedRestorePageSize()).toBe(5)
    saveRestorePageSize(25)
    expect(savedRestorePageSize()).toBe(25)
    localStorage.setItem('shipdok.restorePageSize', '3')
    expect(savedRestorePageSize()).toBe(5)
    const broken = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(savedRestorePageSize()).toBe(5)
    broken.mockRestore()
    const noSave = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => saveRestorePageSize(10)).not.toThrow()
    noSave.mockRestore()
  })
})
