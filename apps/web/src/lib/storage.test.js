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

  describe('volumes', () => {
    const withVolumes = { ...storage, volumes: { totalBytes: 0, measuredAt: null, apps: [{ appId: 'a', slug: 'app-a', count: 2, measured: 1, bytes: 700 }, { appId: 'd', slug: 'app-d', count: 1, measured: 0, bytes: 0 }] } }

    test('are on the row of their app, with how many there are and how many were measured', () => {
      expect(storageRows(withVolumes, []).find((r) => r.appId === 'a')).toMatchObject({ volumes: 2, volumesMeasured: 1, volumeBytes: 700 })
    })
    test('count in the total', () => {
      expect(storageRows(withVolumes, []).find((r) => r.appId === 'a').total).toBe(1000 + 500 + 700)
    })
    test('an app that only has volumes still has a row', () => {
      expect(storageRows(withVolumes, []).find((r) => r.appId === 'd')).toMatchObject({ logBytes: 0, imageBytes: 0, volumes: 1, volumesMeasured: 0, total: 0 })
    })
    test('apps without volumes say so (0), not nothing', () => {
      expect(storageRows(withVolumes, []).find((r) => r.appId === 'b')).toMatchObject({ volumes: 0, volumesMeasured: 0, volumeBytes: 0 })
    })
    test('an answer without a volumes part (an older API) still works', () => {
      expect(storageRows(storage, []).find((r) => r.appId === 'a')).toMatchObject({ volumes: 0, volumeBytes: 0, total: 1500 })
    })
  })
})
