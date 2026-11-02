import { Select } from '@/components/select'
import { Field } from '@/components/field'
import { useApps } from '@/lib/queries'

/** The apps that can receive something (not one that is being deleted), alphabetical. */
export const receivingApps = (apps) => (apps ?? []).filter((a) => !a.deleting_at).sort((a, b) => a.name.localeCompare(b.name))

/** A labelled choice of one of the apps. `value` is an app id or ''. */
export function AppChoice({ id, label = 'Which app', value, onChange, error }) {
  const apps = useApps()
  const list = receivingApps(apps.data)
  return (
    <Field id={id} label={label} error={error} hint={apps.isSuccess && list.length === 0 ? 'There is no app yet. Create one first.' : undefined}>
      <Select id={id} value={value} onChange={onChange} disabled={list.length === 0}>
        <option value="">Choose an app…</option>
        {list.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </Select>
    </Field>
  )
}
