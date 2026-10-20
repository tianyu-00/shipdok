import { NativeSelect } from '@/components/native-select'
import { appLabel } from '@/lib/github-apps'

const CHOOSE = '__choose'

/**
 * Which connected GitHub App a project uses. `value`: an app's id, '' for none (a public repository, deployed by hand), or undefined for
 * "not chosen yet" (only offered with `choose`, so a form with several apps cannot be sent without a decision).
 */
export function GithubAppSelect({ id, value, onChange, apps, choose = false, label = 'GitHub app' }) {
  return (
    <NativeSelect id={id} label={label} value={value === undefined ? CHOOSE : value} onChange={(v) => onChange(v === CHOOSE ? undefined : v)}>
      {choose && value === undefined && <option value={CHOOSE} disabled>Choose a GitHub app…</option>}
      {apps.map((a) => <option key={a.id} value={a.id}>{appLabel(a)}</option>)}
      <option value="">None (a public repository, deployed by hand)</option>
    </NativeSelect>
  )
}
