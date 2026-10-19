import { describe, test, expect } from 'vitest'
import { storageRows } from './storage'

const storage = {
  logs: { totalBytes: 0, apps: [{ appId: 'a', slug: 'app-a', bytes: 1000, files: 3 }, { appId: 'b', slug: 'app-b', bytes: 5, files: 1 }] },
  images: { totalBytes: 0, apps: [{ appId: 'a', slug: 'app-a', images: 2, bytes: 500 }, { appId: 'c', slug: 'app-c', images: 1, bytes: 90_000 }] },
}

describe('storageRows', () => {
  test('one row per app, with logs and images side by side and a total', () => {
    const rows = storageRows(storage, [{ id: 'a', name: 'App A' }])
    expect(rows.find((r) => r.appId === 'a')).toMatchObject({ name: 'App A', logBytes: 1000, logFiles: 3, imageBytes: 500, images: 2, total: 1500 })
  })
  test('apps with only logs or only images are included', () => {
    const rows = storageRows(storage, [])
    expect(rows.find((r) => r.appId === 'b')).toMatchObject({ logBytes: 5, imageBytes: 0, images: 0, total: 5 })
    expect(rows.find((r) => r.appId === 'c')).toMatchObject({ logBytes: 0, imageBytes: 90_000, logFiles: 0 })
  })
  test('biggest first', () => expect(storageRows(storage, []).map((r) => r.appId)).toEqual(['c', 'a', 'b']))
  test('the slug stands in when the app list has not loaded', () => expect(storageRows(storage, []).find((r) => r.appId === 'a').name).toBe('app-a'))
  test('nothing stored, nothing shown', () => {
    expect(storageRows({ logs: { apps: [] }, images: { apps: [] } })).toEqual([])
    expect(storageRows(undefined)).toEqual([])
  })
})
