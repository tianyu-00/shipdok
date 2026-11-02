/** The categories of the activity log, in the order the buttons show them. */
export const AUDIT_CATEGORIES = [
  { value: 'security', label: 'Security' },
  { value: 'github', label: 'GitHub' },
  { value: 'apps', label: 'Apps' },
  { value: 'deployments', label: 'Deployments' },
  { value: 'variables', label: 'Variables' },
  { value: 'storage', label: 'Storage' },
  { value: 'backups', label: 'Backups and restores' },
]

export const categoryLabel = (value) => AUDIT_CATEGORIES.find((c) => c.value === value)?.label ?? value

/** One fact of an entry as a line: a change reads "Mode: Local only → Full" (an empty side is "none"), another fact "Backup: made 3 Nov". */
export function detailText(d) {
  if (d.value !== undefined) return `${d.label}: ${d.value}`
  return `${d.label}: ${d.from || 'none'} → ${d.to || 'none'}`
}
