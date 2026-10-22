import { describe, test, expect, vi, afterEach } from 'vitest'
import { downloadBackup, filenameFrom, isBusy, latestBackups, localHourText, scheduleText, utcHourText, WEEKDAYS } from './backups'
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
