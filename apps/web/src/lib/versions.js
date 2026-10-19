// What the dashboard may offer for a version of an app. The API is the judge (it refuses what is not allowed); these rules only
// decide which buttons are shown, and say why one is missing. They mirror DELETE /api/deployments/:id.

/** deploymentId -> version, from GET /apps/:id/images. */
export const versionsById = (images) => new Map((images?.versions ?? []).map((v) => [v.deploymentId, v]))

export const VERSION_STATE = {
  live: { label: 'Live', tone: 'success' },
  previous: { label: 'Previous', tone: 'info' },
  prunable: { label: 'Old image', tone: 'muted' },
  removed: { label: 'Image removed', tone: 'warning' },
}

/** Why this deployment cannot be deleted right now, or null when it can. `images` may be missing (not loaded yet). */
export function deleteBlockedReason(deployment, images) {
  const versions = images?.versions ?? []
  const mine = versions.find((v) => v.deploymentId === deployment.id)
  if (!mine || mine.state === 'removed') return null
  if (versions[0]?.deploymentId === deployment.id) return 'This is the running version. Deploy a newer one first.'
  const shared = versions.some((v) => v.image === mine.image && v.deploymentId !== deployment.id)
  if (mine.state === 'previous' && !shared) return 'Kept so the app can be rolled back to it. Deploy a newer version, or lower the number of versions kept, first.'
  return null
}

/** Whether deleting this deployment also removes its image (nothing else uses it). */
export function deleteRemovesImage(deployment, images) {
  const versions = images?.versions ?? []
  const mine = versions.find((v) => v.deploymentId === deployment.id)
  if (!mine || mine.state === 'removed') return false
  return !versions.some((v) => v.image === mine.image && v.deploymentId !== deployment.id)
}

/** The versions a clean-up would remove, each image once (several deployments can share one). */
export function prunableVersions(images) {
  const seen = new Set()
  return (images?.versions ?? []).filter((v) => {
    if (v.state !== 'prunable' || seen.has(v.image)) return false
    seen.add(v.image)
    return true
  })
}
