// GET /api/storage lists log bytes and image bytes per app in two separate lists. The page wants one row per app.

/** One row per app that has anything stored, biggest first. `apps` (from GET /api/apps) gives the display names. */
export function storageRows(storage, apps = []) {
  const names = new Map(apps.map((a) => [a.id, a.name]))
  const rows = new Map()
  const row = (appId, slug) => {
    if (!rows.has(appId)) rows.set(appId, { appId, name: names.get(appId) ?? slug, slug, logBytes: 0, logFiles: 0, imageBytes: 0, images: 0 })
    return rows.get(appId)
  }
  for (const l of storage?.logs?.apps ?? []) { const r = row(l.appId, l.slug); r.logBytes += l.bytes; r.logFiles += l.files }
  for (const i of storage?.images?.apps ?? []) { const r = row(i.appId, i.slug); r.imageBytes += i.bytes; r.images += i.images }
  return [...rows.values()].map((r) => ({ ...r, total: r.logBytes + r.imageBytes })).sort((a, b) => b.total - a.total)
}
